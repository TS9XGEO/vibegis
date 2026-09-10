"""Polls the Docker Engine API for every running container's stats and
exposes them as Prometheus metrics, labeled the same way promtail labels
its log streams (service = Compose service name, container = container
name) so the Grafana dashboard's $service picker filters logs and
resource graphs identically.

Deliberately socket-only (no /sys, no /var/lib/docker bind mount) — this
stack runs on Docker Desktop, whose engine lives in its own isolated VM.
cAdvisor's usual approach (reading cgroup/overlay2 files directly) cannot
see across that boundary and only reports empty host cgroup slices; the
Docker socket is the one channel that does work (it's the same read-only
mount promtail already uses for log discovery), so this polls
/containers/{id}/stats over it instead.
"""
import time

import os

import docker
from prometheus_client import Gauge, start_http_server

POLL_INTERVAL_SECONDS = 10
METRICS_PORT = 9100

LABELS = ["service", "container"]
cpu_percent = Gauge("dockerstats_cpu_percent", "CPU usage percent (100 = one full core)", LABELS)
mem_usage_bytes = Gauge("dockerstats_memory_usage_bytes", "Memory usage in bytes, cache excluded", LABELS)
mem_limit_bytes = Gauge("dockerstats_memory_limit_bytes", "Memory limit in bytes", LABELS)
net_rx_bytes = Gauge("dockerstats_network_receive_bytes_total", "Cumulative bytes received since container start", LABELS)
net_tx_bytes = Gauge("dockerstats_network_transmit_bytes_total", "Cumulative bytes transmitted since container start", LABELS)
blkio_read_bytes = Gauge("dockerstats_blkio_read_bytes_total", "Cumulative bytes read from block devices since container start", LABELS)
blkio_write_bytes = Gauge("dockerstats_blkio_write_bytes_total", "Cumulative bytes written to block devices since container start", LABELS)


def calc_cpu_percent(stats: dict) -> float:
    cpu = stats.get("cpu_stats", {})
    precpu = stats.get("precpu_stats", {})
    cpu_total = cpu.get("cpu_usage", {}).get("total_usage")
    precpu_total = precpu.get("cpu_usage", {}).get("total_usage")
    system = cpu.get("system_cpu_usage")
    presystem = precpu.get("system_cpu_usage")
    if None in (cpu_total, precpu_total, system, presystem):
        return 0.0
    cpu_delta = cpu_total - precpu_total
    system_delta = system - presystem
    if system_delta <= 0 or cpu_delta < 0:
        return 0.0
    online_cpus = cpu.get("online_cpus") or len(cpu.get("cpu_usage", {}).get("percpu_usage") or [1])
    return (cpu_delta / system_delta) * online_cpus * 100.0


def calc_memory_usage(stats: dict) -> float:
    mem = stats.get("memory_stats", {})
    usage = mem.get("usage", 0)
    # Docker's raw "usage" includes page cache; subtract it the same way the
    # `docker stats` CLI does, for a number that reflects what the process
    # actually holds rather than reclaimable cache. cgroup v1 calls it
    # "cache", cgroup v2 calls it "inactive_file".
    detail = mem.get("stats", {})
    cache = detail.get("cache", detail.get("inactive_file", 0))
    return max(0.0, float(usage) - float(cache))


def sum_network(stats: dict, key: str) -> float:
    networks = stats.get("networks") or {}
    return float(sum(iface.get(key, 0) for iface in networks.values()))


def sum_blkio(stats: dict, op: str) -> float:
    entries = (stats.get("blkio_stats") or {}).get("io_service_bytes_recursive") or []
    return float(sum(e.get("value", 0) for e in entries if e.get("op", "").lower() == op))


def poll_once(client: docker.DockerClient) -> None:
    for c in client.containers.list():
        service = c.labels.get("com.docker.compose.service", c.name)
        labels = (service, c.name)
        try:
            stats = c.stats(stream=False)
        except Exception as e:
            print(f"stats failed for {c.name}: {e}", flush=True)
            continue
        cpu_percent.labels(*labels).set(calc_cpu_percent(stats))
        mem_usage_bytes.labels(*labels).set(calc_memory_usage(stats))
        mem_limit_bytes.labels(*labels).set(stats.get("memory_stats", {}).get("limit", 0))
        net_rx_bytes.labels(*labels).set(sum_network(stats, "rx_bytes"))
        net_tx_bytes.labels(*labels).set(sum_network(stats, "tx_bytes"))
        blkio_read_bytes.labels(*labels).set(sum_blkio(stats, "read"))
        blkio_write_bytes.labels(*labels).set(sum_blkio(stats, "write"))


def main() -> None:
    start_http_server(METRICS_PORT)
    # Points at the docker-socket-proxy service by default (see
    # docker-compose.yml), not at the raw socket: anything that can reach the
    # socket directly can also read every other container's environment, which
    # is where this stack keeps its database password and JWT secret. The proxy
    # allows only the /containers endpoints this poller needs.
    client = docker.DockerClient(base_url=os.environ.get("DOCKER_HOST", "tcp://docker-socket-proxy:2375"))
    while True:
        try:
            poll_once(client)
        except Exception as e:
            print(f"poll loop error: {e}", flush=True)
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
