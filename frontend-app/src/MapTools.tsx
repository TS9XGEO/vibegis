/**
 * Search box, identify-on-click and measure tools.
 * Rendered inside the Resium <Viewer> so it can reach the Cesium instance.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import {
  IconInfoCircle,
  IconLine,
  IconPolygon,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import {
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidGeodesic,
  Math as CesiumMath,
  ScreenSpaceEventType,
} from 'cesium'
import { useCesium } from 'resium'

import { formatArea, formatDistance, identifyAt, useTools } from './tools'
import { useApp } from './wms'

// ------------------------------------------------------------- geodesy ----

function geodesicLength(points: Cartographic[]): number {
  const g = new EllipsoidGeodesic()
  let total = 0
  for (let i = 1; i < points.length; i++) {
    g.setEndPoints(points[i - 1], points[i])
    total += g.surfaceDistance
  }
  return total
}

/** Spherical excess: accurate enough for anything short of a continent. */
function sphericalArea(points: Cartographic[]): number {
  if (points.length < 3) return 0
  const R = 6378137
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i]
    const p2 = points[(i + 1) % points.length]
    sum += (p2.longitude - p1.longitude) * (2 + Math.sin(p1.latitude) + Math.sin(p2.latitude))
  }
  return Math.abs((sum * R * R) / 2)
}

// ------------------------------------------------------------------ tools --

export default function MapTools() {
  const { viewer, scene, camera } = useCesium()
  const layers = useApp((s) => s.layers)

  const {
    query, hits, searching, searchError,
    setQuery, runSearch, clearSearch,
    identifyOn, identifyBusy, results, setIdentify, setResults, setIdentifyBusy,
    measure, measureValue, setMeasure, setMeasureValue,
  } = useTools()

  const [debounced, setDebounced] = useState('')
  const measurePoints = useRef<Cartesian3[]>([])
  const measureEntities = useRef<any[]>([])

  // ---- search, debounced -------------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (debounced.trim().length >= 2) runSearch(debounced)
  }, [debounced, runSearch])

  function flyToHit(lon: number, lat: number) {
    camera?.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, 2500),
      duration: 1.5,
    })
  }

  // ---- identify ----------------------------------------------------------
  useEffect(() => {
    if (!viewer || !scene || !identifyOn) return
    const handler = viewer.screenSpaceEventHandler

    const onClick = async (movement: any) => {
      const carto = scene.camera.pickEllipsoid
        ? Cartographic.fromCartesian(
            scene.camera.pickEllipsoid(movement.position) ?? new Cartesian3(),
          )
        : null
      if (!carto) return

      const lon = CesiumMath.toDegrees(carto.longitude)
      const lat = CesiumMath.toDegrees(carto.latitude)
      const mpp = scene.camera.positionCartographic.height / scene.canvas.clientHeight

      setIdentifyBusy(true)
      const visible = layers.filter((l) => l.visible).map((l) => l.name)
      const all = await Promise.all(visible.map((n) => identifyAt(n, lon, lat, mpp)))
      setResults(all.flat())
      setIdentifyBusy(false)
    }

    handler.setInputAction(onClick, ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
  }, [viewer, scene, identifyOn, layers, setResults, setIdentifyBusy])

  // ---- measure -----------------------------------------------------------
  function clearMeasure() {
    measureEntities.current.forEach((e) => viewer?.entities.remove(e))
    measureEntities.current = []
    measurePoints.current = []
    setMeasureValue(null)
  }

  useEffect(() => {
    if (!viewer || !scene) return
    if (measure === 'off') {
      clearMeasure()
      return
    }

    clearMeasure()
    const handler = viewer.screenSpaceEventHandler

    const positions = measurePoints.current
    const line = viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(() => positions.slice(), false),
        width: 2.5,
        material: Color.fromCssColorString('#7ec8ff'),
        clampToGround: true,
      },
    })
    measureEntities.current.push(line)

    if (measure === 'area') {
      const poly = viewer.entities.add({
        polygon: {
          hierarchy: new CallbackProperty(
            () => ({ positions: positions.slice(), holes: [] }),
            false,
          ),
          material: Color.fromCssColorString('#7ec8ff').withAlpha(0.25),
        },
      })
      measureEntities.current.push(poly)
    }

    const recompute = () => {
      const cartos = positions.map((p) => Cartographic.fromCartesian(p))
      if (measure === 'distance') {
        setMeasureValue(cartos.length >= 2 ? formatDistance(geodesicLength(cartos)) : null)
      } else {
        setMeasureValue(cartos.length >= 3 ? formatArea(sphericalArea(cartos)) : null)
      }
    }

    const onClick = (movement: any) => {
      const c = scene.camera.pickEllipsoid(movement.position)
      if (!c) return
      positions.push(c)
      const dot = viewer.entities.add({
        position: c,
        point: {
          pixelSize: 7,
          color: Color.WHITE,
          outlineColor: Color.fromCssColorString('#7ec8ff'),
          outlineWidth: 2,
        },
      })
      measureEntities.current.push(dot)
      recompute()
    }

    const onRightClick = () => {
      setMeasure('off')
    }

    handler.setInputAction(onClick, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction(onRightClick, ScreenSpaceEventType.RIGHT_CLICK)

    return () => {
      handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
      handler.removeInputAction(ScreenSpaceEventType.RIGHT_CLICK)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, scene, measure])

  // ---- ui ----------------------------------------------------------------
  return (
    <Paper
      shadow="md"
      radius="md"
      withBorder
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 20,
        width: 320,
        maxHeight: 'calc(100% - 20px)',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'rgba(20,22,28,0.92)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <Box p="xs">
        <TextInput
          size="xs"
          placeholder="Suchen: Ort, Strasse, Gebaeude…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          leftSection={searching ? <Loader size={12} /> : <IconSearch size={14} />}
          rightSection={
            query ? (
              <ActionIcon variant="subtle" size="sm" color="gray" onClick={clearSearch}>
                <IconX size={13} />
              </ActionIcon>
            ) : null
          }
        />

        {searchError && (
          <Alert color="red" variant="light" p={6} mt={6}>
            <Text size="xs">{searchError}</Text>
          </Alert>
        )}

        {hits.length > 0 && (
          <ScrollArea.Autosize mah={220} mt={6}>
            <Stack gap={2}>
              {hits.map((h, i) => (
                <Group
                  key={`${h.name}-${i}`}
                  gap={6}
                  wrap="nowrap"
                  p={4}
                  style={{ borderRadius: 4, cursor: 'pointer' }}
                  onClick={() => flyToHit(h.lon, h.lat)}
                >
                  <Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate>
                    {h.name}
                  </Text>
                  <Badge size="xs" variant="light" color="gray">
                    {h.category}
                  </Badge>
                </Group>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        )}

        <Group gap={6} mt={8}>
          <Tooltip label="Objekte abfragen (Klick auf die Karte)" withArrow>
            <ActionIcon
              variant={identifyOn ? 'filled' : 'subtle'}
              color={identifyOn ? 'blue' : 'gray'}
              size="sm"
              onClick={() => { setMeasure('off'); setIdentify(!identifyOn) }}
            >
              <IconInfoCircle size={15} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Strecke messen (Rechtsklick beendet)" withArrow>
            <ActionIcon
              variant={measure === 'distance' ? 'filled' : 'subtle'}
              color={measure === 'distance' ? 'blue' : 'gray'}
              size="sm"
              onClick={() => {
                setIdentify(false)
                setMeasure(measure === 'distance' ? 'off' : 'distance')
              }}
            >
              <IconLine size={15} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Flaeche messen (Rechtsklick beendet)" withArrow>
            <ActionIcon
              variant={measure === 'area' ? 'filled' : 'subtle'}
              color={measure === 'area' ? 'blue' : 'gray'}
              size="sm"
              onClick={() => {
                setIdentify(false)
                setMeasure(measure === 'area' ? 'off' : 'area')
              }}
            >
              <IconPolygon size={15} />
            </ActionIcon>
          </Tooltip>

          {measureValue && (
            <Badge size="sm" variant="light" color="blue" ml="auto">
              {measureValue}
            </Badge>
          )}
          {identifyBusy && <Loader size={12} ml="auto" />}
        </Group>

        {(identifyOn || measure !== 'off') && (
          <Text size="10px" c="dimmed" mt={4}>
            {measure !== 'off'
              ? 'Punkte klicken, Rechtsklick beendet die Messung.'
              : 'Auf ein Objekt in der Karte klicken.'}
          </Text>
        )}
      </Box>

      {results.length > 0 && (
        <ScrollArea.Autosize mah="calc(100vh - 320px)">
          <Box px="xs" pb="xs">
            {results.map((r, i) => (
              <Box key={i} mb={8}>
                <Badge size="xs" variant="light" mb={2}>{r.layer}</Badge>
                <Table withRowBorders={false} verticalSpacing={1} fz="11px">
                  <Table.Tbody>
                    {Object.entries(r.properties)
                      .filter(([, v]) => v !== null && v !== '')
                      .slice(0, 14)
                      .map(([k, v]) => (
                        <Table.Tr key={k}>
                          <Table.Td c="dimmed" style={{ width: '40%' }}>{k}</Table.Td>
                          <Table.Td>{String(v)}</Table.Td>
                        </Table.Tr>
                      ))}
                  </Table.Tbody>
                </Table>
              </Box>
            ))}
          </Box>
        </ScrollArea.Autosize>
      )}
    </Paper>
  )
}
