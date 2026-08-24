/**
 * Attribute table for the layer panel's per-layer table button: a paginated
 * grid of a layer's real feature data (columns = fields, rows = features),
 * read straight from the pg_featureserv OGC API Features endpoint that's
 * already deployed for the search box (see tools.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Drawer, Group, Loader, ScrollArea, Table, Text } from '@mantine/core'

import { FEATURES_URL } from './tools'
import { collectionFor, useApp, type LayerState } from './wms'

const PAGE_SIZE = 25

interface AttrFeature {
  id: string
  properties: Record<string, unknown>
}

async function fetchPage(
  collection: string,
  offset: number,
  signal?: AbortSignal,
): Promise<AttrFeature[]> {
  const url =
    `${FEATURES_URL}/collections/${encodeURIComponent(collection)}/items` +
    `?limit=${PAGE_SIZE}&offset=${offset}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Sachdaten: HTTP ${res.status}`)
  const json = await res.json()
  return (json.features ?? []).map((f: any) => ({
    id: String(f.id ?? ''),
    properties: f.properties ?? {},
  }))
}

export default function AttributeTable({
  layer,
  onClose,
}: {
  layer: LayerState | null
  onClose: () => void
}) {
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const collection = layer ? collectionFor(layer.name, dynamicCollections) : undefined

  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState<AttrFeature[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset paging whenever a different layer's table is opened.
  useEffect(() => {
    setOffset(0)
  }, [layer?.name])

  useEffect(() => {
    if (!collection) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetchPage(collection, offset, controller.signal)
      .then((r) => {
        setRows(r)
        setLoading(false)
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => controller.abort()
  }, [collection, offset])

  // pg_featureserv doesn't report a total count, so columns come from
  // whatever the current page actually returned.
  const columns = useMemo(() => {
    const keys = new Set<string>()
    rows.forEach((r) => Object.keys(r.properties).forEach((k) => keys.add(k)))
    return Array.from(keys)
  }, [rows])

  return (
    <Drawer
      opened={!!layer}
      onClose={onClose}
      position="bottom"
      size="45%"
      title={layer ? `Sachdaten: ${layer.title}` : ''}
      styles={{
        content: { backgroundColor: 'rgba(20,22,28,0.98)' },
        header: { backgroundColor: 'rgba(20,22,28,0.98)' },
      }}
    >
      {!collection && (
        <Alert color="yellow" variant="light">
          Für diesen Layer sind keine Sachdaten verfügbar.
        </Alert>
      )}

      {collection && (
        <>
          {loading && (
            <Group gap={8}>
              <Loader size="xs" />
              <Text size="xs" c="dimmed">lade…</Text>
            </Group>
          )}

          {error && (
            <Alert color="red" variant="light">
              <Text size="xs">{error}</Text>
            </Alert>
          )}

          {!loading && !error && (
            <>
              <ScrollArea>
                <Table striped withTableBorder stickyHeader fz="xs">
                  <Table.Thead>
                    <Table.Tr>
                      {columns.map((c) => (
                        <Table.Th key={c}>{c}</Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.map((r) => (
                      <Table.Tr key={r.id}>
                        {columns.map((c) => (
                          <Table.Td key={c}>{String(r.properties[c] ?? '')}</Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>

              <Group justify="space-between" mt="sm">
                <Text size="xs" c="dimmed">
                  {rows.length === 0 ? '0 Zeilen' : `${offset + 1}–${offset + rows.length}`}
                </Text>
                <Group gap={6}>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={offset === 0}
                    onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  >
                    Zurück
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={rows.length < PAGE_SIZE}
                    onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  >
                    Weiter
                  </Button>
                </Group>
              </Group>
            </>
          )}
        </>
      )}
    </Drawer>
  )
}
