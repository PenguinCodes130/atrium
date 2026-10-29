// The component catalogue (architecture v3 section 4.4, spec 3.1.1): one ComponentDef per type, the
// single source for the Insert tab, the inspector, validate, the schema tool and the agent guides.
import type { ComponentDef, ComponentType } from "@/core/contracts";
import { META, SIZING, type ComponentMeta } from "./meta";
import { propsSchemas, type BuiltInType } from "./schemas";
import { CardView, GridView, RepeatView, SectionView, StackView, TabsView } from "../render/layout";
import { GaugeView, ListView, ProgressView, StatView, StatusView, TableView } from "../render/data";
import { ChartView } from "../render/chart";
import { ClockView, DividerView, HeadingView, IconView, ImageView, LinkView, SpacerView, TextView } from "../render/content";
import { ButtonView, SelectView, SliderView, ToggleView } from "../render/controls";
import { HtmlBlockView } from "../render/html-block";
import { VideoView } from "../render/video";
import { BookmarksView, GroupView, ResourceBarView, ServiceTileView } from "../render/tiles";

const VIEWS: Record<BuiltInType, ComponentDef["Component"]> = {
  grid: GridView, stack: StackView, card: CardView, tabs: TabsView, section: SectionView, repeat: RepeatView,
  stat: StatView, chart: ChartView, table: TableView, list: ListView, status: StatusView, gauge: GaugeView, progress: ProgressView,
  heading: HeadingView, text: TextView, image: ImageView, video: VideoView, icon: IconView, link: LinkView, divider: DividerView, spacer: SpacerView, clock: ClockView,
  button: ButtonView, toggle: ToggleView, slider: SliderView, select: SelectView,
  html: HtmlBlockView,
  "service-tile": ServiceTileView, group: GroupView, "resource-bar": ResourceBarView, bookmarks: BookmarksView,
};

function toDef(m: ComponentMeta): ComponentDef {
  return {
    type: m.type,
    title: m.title,
    category: m.category,
    container: m.container,
    props: propsSchemas[m.type],
    defaults: m.defaults,
    ...(m.accepts ? { accepts: m.accepts } : {}),
    sizing: SIZING[m.type],
    styleSlots: m.styleSlots,
    ...(m.states ? { states: m.states } : {}),
    docs: m.docs,
    Component: VIEWS[m.type],
  };
}

const BUILT_IN: ComponentDef[] = (Object.keys(META) as BuiltInType[]).map((t) => toDef(META[t]));
const packages = new Map<string, ComponentDef>();

/** Official packages (src/packages, amendment A4.2) register their page-rendered components here at build time. */
export function registerPackageComponent(def: ComponentDef): void {
  if (!String(def.type).startsWith("pkg:")) throw new Error("Package components use a pkg: type");
  // A11.2: package components default to fit.
  packages.set(def.type, def.sizing ? def : { ...def, sizing: "fit" });
}

export function componentDefs(): ComponentDef[] {
  return [...BUILT_IN, ...packages.values()];
}

export function getComponentDef(type: ComponentType): ComponentDef | undefined {
  return BUILT_IN.find((d) => d.type === type) ?? packages.get(type);
}
