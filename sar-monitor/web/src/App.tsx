import { useEffect, useMemo, useState } from "react";
import type { AisShip, Detection, Infrastructure, Scene } from "@/api";
import {
  cropUrl,
  loadAis,
  loadDetections,
  loadInfrastructure,
  loadScenes,
} from "@/api";
import { COLORS, fmt, fmtDateTime, INFRA, num, REGION_NAMES } from "@/theme";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SceneMap, type Layers, type Selection } from "@/components/SceneMap";
import { DetailSheet } from "@/components/DetailSheet";

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}
function Ring({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full border-2"
      style={{ borderColor: color }}
    />
  );
}

type LayerRow = {
  key: keyof Layers;
  label: string;
  hint: string;
  swatch: React.ReactNode;
};

// The legend, grouped by what a marker means rather than by where the data came from.
const LAYER_GROUPS: { title: string; hint: string; rows: LayerRow[] }[] = [
  {
    title: "Dark vessels",
    hint: "Seen on radar, but not broadcasting AIS",
    rows: [
      {
        key: "dark",
        label: "Dark candidate",
        hint: "Radar detection with no AIS ship nearby",
        swatch: <Dot color={COLORS.dark} />,
      },
    ],
  },
  {
    title: "Transparent fleet",
    hint: "Ships broadcasting their position over AIS",
    rows: [
      {
        key: "matched",
        label: "Seen on radar",
        hint: "Radar detection matched to an AIS ship",
        swatch: <Dot color={COLORS.matched} />,
      },
      {
        key: "aisMatched",
        label: "Reported position",
        hint: "Where that ship said it was at the pass",
        swatch: <Ring color={COLORS.matched} />,
      },
      {
        key: "aisOnly",
        label: "Not found on radar",
        hint: "Broadcasting AIS, but no radar detection (often in port)",
        swatch: <Ring color={COLORS.aisOnly} />,
      },
    ],
  },
  {
    title: "Background",
    hint: "Context under the ship markers",
    rows: [
      {
        key: "radar",
        label: "Radar image",
        hint: "The Sentinel-1 image the detections come from",
        swatch: (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-sm bg-neutral-500"
          />
        ),
      },
      {
        key: "infrastructure",
        label: "Offshore infrastructure",
        hint: "Wind farms, pipelines and cables",
        swatch: (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-[3px] border-2"
            style={{ borderColor: INFRA.wind_farm.color }}
          />
        ),
      },
    ],
  },
];

function Kpi({
  label,
  value,
  sub,
  swatch,
}: {
  label: string;
  value: string;
  sub?: string;
  swatch?: React.ReactNode;
}) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 text-xs">
          {swatch}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {sub && <CardDescription className="text-xs">{sub}</CardDescription>}
      </CardHeader>
    </Card>
  );
}

function nearText(d: Detection) {
  if (!d.near) return "No infrastructure within 5 km";
  const what = d.near.name
    ? `${INFRA[d.near.kind].label} ${d.near.name}`
    : INFRA[d.near.kind].label;
  return d.near.distance_m === 0
    ? `Inside ${what}`
    : `${what}, ${(d.near.distance_m / 1000).toFixed(1)} km`;
}

const sceneLabel = (s: Scene) =>
  `${fmtDateTime(s.start_ts)} · ${REGION_NAMES[s.region] ?? s.region}`;

export default function App() {
  const [scenes, setScenes] = useState<Scene[] | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [ships, setShips] = useState<AisShip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [minScore, setMinScore] = useState(98);
  const [minLength, setMinLength] = useState(0);
  const [layers, setLayers] = useState<Layers>({
    radar: true,
    dark: true,
    matched: true,
    aisMatched: true,
    aisOnly: false,
    infrastructure: false,
  });
  const [infrastructure, setInfrastructure] = useState<Infrastructure | null>(
    null,
  );
  // Only show legend entries for the kinds that are actually on the map
  const infraKinds = useMemo(
    () => new Set(infrastructure?.features.map((f) => f.properties.kind)),
    [infrastructure],
  );
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    loadScenes().then(
      (s) => {
        setScenes(s);
        setSceneId(s[0]?.id ?? null);
      },
      (e) => setError(String(e.message ?? e)),
    );
  }, []);

  useEffect(() => {
    loadInfrastructure().then(setInfrastructure, () => {}); // the map works without it
  }, []);

  useEffect(() => {
    if (!sceneId) return;
    let live = true;
    setSelection(null);
    Promise.all([loadDetections(sceneId), loadAis(sceneId)]).then(
      ([d, a]) => {
        if (!live) return;
        setDetections(d);
        setShips(a);
      },
      (e) => live && setError(String(e.message ?? e)),
    );
    return () => {
      live = false;
    };
  }, [sceneId]);

  const scene = scenes?.find((s) => s.id === sceneId) ?? null;

  // Filters apply to dark candidates only: a matched detection is confirmed by AIS whatever its score.
  const shown = useMemo(
    () =>
      detections.filter(
        (d) =>
          d.mmsi != null ||
          (d.score * 100 >= minScore && (d.length_m ?? 0) >= minLength),
      ),
    [detections, minScore, minLength],
  );
  const dark = useMemo(
    () =>
      shown
        .filter((d) => d.mmsi == null)
        .sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)),
    [shown],
  );
  const byScore = useMemo(
    () => [...dark].sort((a, b) => b.score - a.score),
    [dark],
  );
  const matched = shown.length - dark.length;
  // Every boat in the image: all ships broadcasting AIS plus the dark candidates, largest first
  const allBoats = useMemo(() => {
    const rows = [
      ...ships.map((item) => ({
        key: `s${item.mmsi}`,
        length: item.length_m,
        sel: { kind: "ship", item } as Selection,
      })),
      ...dark.map((item) => ({
        key: item.id,
        length: item.length_m,
        sel: { kind: "detection", item } as Selection,
      })),
    ];
    return rows.sort((a, b) => (b.length ?? 0) - (a.length ?? 0));
  }, [ships, dark]);

  if (error)
    return (
      <div className="grid h-svh place-content-center gap-2 p-6 text-center">
        <h1 className="text-xl font-semibold">Could not load data</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
        <p className="text-sm text-muted-foreground">
          Is the API running on port 8020?
        </p>
      </div>
    );
  if (!scenes)
    return (
      <div className="grid h-svh place-content-center text-muted-foreground">
        Loading scenes…
      </div>
    );
  if (!scene)
    return (
      <div className="grid h-svh place-content-center gap-2 p-6 text-center">
        <h1 className="text-xl font-semibold">No scenes yet</h1>
        <p className="text-sm text-muted-foreground">
          Run detection and matching first:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            uv run python -m pipeline.detect
          </code>
        </p>
      </div>
    );

  return (
    <div className="grid h-full grid-cols-1 overflow-hidden md:grid-cols-[420px_1fr]">
      <aside className="hidden min-h-0 border-r bg-sidebar md:block">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-6 p-5">
            <header className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                Dark Vessel Monitor
              </h1>
              <p className="text-xs text-muted-foreground">
                Ships found by a detection model on Sentinel-1 radar images,
                compared with the ships that were broadcasting AIS at the same
                moment.
              </p>
            </header>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">Satellite pass</Label>
              <Select value={scene.id} onValueChange={setSceneId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scenes.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {sceneLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">
                  {scene.platform
                    .replace("sentinel-", "Sentinel-")
                    .toUpperCase()
                    .replace("SENTINEL", "Sentinel")}
                </Badge>
                {scene.orbit_state && (
                  <Badge variant="outline">{scene.orbit_state} orbit</Badge>
                )}
                {scene.detect_seconds != null && (
                  <Badge variant="outline">
                    detection took {num(scene.detect_seconds / 60, "min", 1)}
                  </Badge>
                )}
              </div>
            </div>

            <Tabs defaultValue="overview" className="gap-5">
              <TabsList className="w-full">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="dark">
                  Dark candidates ({dark.length})
                </TabsTrigger>
                <TabsTrigger value="ais">
                  All boats ({allBoats.length})
                </TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="flex flex-col gap-6">
                <div className="grid grid-cols-2 gap-2">
                  <Kpi
                    label="Matched vessels"
                    value={fmt.format(matched)}
                    sub="seen on radar and broadcasting AIS"
                    swatch={<Dot color={COLORS.matched} />}
                  />
                  <Kpi
                    label="Dark vessels"
                    value={fmt.format(dark.length)}
                    sub="seen on radar, no AIS nearby"
                    swatch={<Dot color={COLORS.dark} />}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="text-muted-foreground">Map layers</Label>
                  <div className="flex flex-col gap-4">
                    {LAYER_GROUPS.map((g) => (
                      <div key={g.title} className="flex flex-col gap-2.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">{g.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {g.hint}
                          </span>
                        </div>
                        {g.rows.map((l) => (
                          <div key={l.key} className="flex items-start gap-2.5">
                            <Checkbox
                              id={`layer-${l.key}`}
                              checked={layers[l.key]}
                              onCheckedChange={(v) =>
                                setLayers((s) => ({
                                  ...s,
                                  [l.key]: v === true,
                                }))
                              }
                            />
                            <div className="flex flex-col gap-1">
                              <Label
                                htmlFor={`layer-${l.key}`}
                                className="font-normal"
                              >
                                {l.swatch}
                                {l.label}
                              </Label>
                              <span className="pl-4.5 text-xs text-muted-foreground">
                                {l.hint}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  {layers.infrastructure && (
                    <div className="ml-6.5 grid grid-cols-2 gap-x-4 gap-y-1.5 border-l pl-3 text-xs text-muted-foreground">
                      {Object.entries(INFRA)
                        .filter(
                          ([kind]) =>
                            !infrastructure || infraKinds.has(kind as never),
                        )
                        .map(([kind, v]) => (
                          <span key={kind} className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="inline-block h-0.5 w-4 shrink-0 rounded-full"
                              style={{ background: v.color }}
                            />
                            {v.label}
                          </span>
                        ))}
                    </div>
                  )}
                </div>

                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
                    Advanced settings
                    <span
                      aria-hidden
                      className="text-xs transition-transform group-open:rotate-180"
                    >
                      ▾
                    </span>
                  </summary>
                  <div className="flex flex-col gap-4 pt-4">
                    <Label className="text-muted-foreground">
                      Filter dark candidates
                    </Label>
                    <div className="flex flex-col gap-2">
                      <div className="flex justify-between text-sm">
                        <span>Model confidence at least</span>
                        <span className="font-medium tabular-nums">
                          {minScore}%
                        </span>
                      </div>
                      <Slider
                        min={30}
                        max={100}
                        step={1}
                        value={[minScore]}
                        onValueChange={([v]) => setMinScore(v)}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <div className="flex justify-between text-sm">
                        <span>Estimated length at least</span>
                        <span className="font-medium tabular-nums">
                          {minLength} m
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={150}
                        step={5}
                        value={[minLength]}
                        onValueChange={([v]) => setMinLength(v)}
                      />
                    </div>
                  </div>
                </details>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  A dark candidate is a radar detection with no AIS ship within
                  reach at the moment of the pass. It is not proof of a ship
                  hiding: small boats often do not have to carry AIS. The model
                  compares each image with two earlier ones of the same place to
                  leave out wind turbines and platforms. Infrastructure: EMODnet
                  Human Activities and © OpenStreetMap contributors. Detection
                  model: Ai2 Skylight (Apache 2.0). Radar: Copernicus
                  Sentinel-1.
                </p>
              </TabsContent>
              <TabsContent value="dark" className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                  Radar detections with no AIS ship nearby, most confident
                  first. Click one to see it on the map.
                </p>
                <ul className="flex flex-col gap-2">
                  {byScore.map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        aria-pressed={selection?.item === d}
                        onClick={() =>
                          setSelection({ kind: "detection", item: d })
                        }
                        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-card p-2 text-left transition-colors hover:bg-accent aria-pressed:border-foreground"
                      >
                        <img
                          src={cropUrl(d.id, "vv")}
                          alt="Radar cut-out, this pass"
                          loading="lazy"
                          className="size-16 shrink-0 rounded-md border bg-muted object-cover"
                        />
                        <img
                          src={cropUrl(d.id, "before")}
                          alt="Same spot, previous pass"
                          loading="lazy"
                          className="size-16 shrink-0 rounded-md border bg-muted object-cover"
                        />
                        <span className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                          <span className="text-sm font-medium text-foreground tabular-nums">
                            {(d.score * 100).toFixed(1)}% confidence
                          </span>
                          <span className="tabular-nums">
                            {num(d.length_m, "m")} · {num(d.speed_kn, "kn", 1)}
                          </span>
                          <span className="truncate">{nearText(d)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {dark.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    None with the current filters (Overview, Advanced settings).
                  </p>
                )}
              </TabsContent>
              <TabsContent value="ais" className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                  Every boat in the image, largest first: ships broadcasting AIS
                  and the dark candidates. Click one to see it on the map.
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Dot color={COLORS.matched} />
                    AIS and radar
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Ring color={COLORS.aisOnly} />
                    AIS, not on radar
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Dot color={COLORS.dark} />
                    Radar, no AIS
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Boat</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Length</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allBoats.map(({ key, sel }) => (
                      <TableRow
                        key={key}
                        className="cursor-pointer"
                        data-state={
                          selection?.item === sel.item ? "selected" : undefined
                        }
                        onClick={() => setSelection(sel)}
                      >
                        <TableCell className="max-w-40 truncate">
                          <span className="flex items-center gap-2">
                            {sel.kind === "detection" ? (
                              <Dot color={COLORS.dark} />
                            ) : sel.item.detection_id != null ? (
                              <Dot color={COLORS.matched} />
                            ) : (
                              <Ring color={COLORS.aisOnly} />
                            )}
                            <span className="truncate">
                              {sel.kind === "detection"
                                ? "Unknown (dark candidate)"
                                : (sel.item.name ?? sel.item.mmsi)}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="max-w-24 truncate text-muted-foreground">
                          {sel.kind === "detection"
                            ? "–"
                            : (sel.item.ship_type ?? "–")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {sel.kind === "detection"
                            ? `≈ ${num(sel.item.length_m, "m")}`
                            : num(sel.item.length_m, "m")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {allBoats.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No boats in this image.
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </ScrollArea>
      </aside>

      <main className="relative min-h-0 min-w-0">
        <SceneMap
          key={scene.id}
          scene={scene}
          detections={shown}
          ships={ships}
          infrastructure={infrastructure}
          layers={layers}
          selection={selection}
          onSelect={setSelection}
        />
      </main>

      <DetailSheet
        selection={selection}
        ships={ships}
        onClose={() => setSelection(null)}
      />
    </div>
  );
}
