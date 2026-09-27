/** The shapes the builder edits. Deliberately loose where the schema allows passthrough. */

export type EmbedType =
  | 'liveboard' | 'viz' | 'search' | 'searchbar' | 'app' | 'spotter' | 'conversation';

export interface EmbedAction {
  type: 'set' | 'open-modal' | 'close-modal' | 'HostEvent' | 'nav' | 'open-url' | 'run-code'
    | 'remount' | 'update-embed';
  /** run-code carries { name, code, store?, timeout?, fallback? }. */
  params: Record<string, unknown>;
}

export interface EmbedEventHandler {
  type: string;
  id?: string;
  actions: EmbedAction[];
  /** A run-code action whose return value answers the SDK responder (ApiIntercept…). */
  respond?: EmbedAction;
}

export interface EmbedSpec {
  type: EmbedType;
  /** How a host-event action addresses this embed. Defaults to its index on the page. */
  name?: string;
  preRender?: boolean;
  height?: string;
  width?: string;
  /** The SDK constructor config, whole. */
  config: Record<string, unknown>;
  embedEventHandlers?: EmbedEventHandler[];
  /** Runs before the embed is constructed; a run-code result object amends the config. */
  beforeRender?: EmbedAction[];
}

export interface Column {
  span?: number;
  blocks: Block[];
}

export interface Block {
  type: 'heading' | 'text' | 'divider' | 'spacer' | 'value' | 'buttons' | 'embed' | 'row';
  text?: string;
  level?: number;
  size?: string;
  key?: string;
  label?: string;
  items?: Array<{ label?: string; variant?: string; actions?: EmbedAction[]; [k: string]: unknown }>;
  embed?: EmbedSpec;
  columns?: Column[];
  [k: string]: unknown;
}

export interface Page {
  /** Hand-written code for the ‹/› view, per flavour. */
  codeOverride?: { cdn?: string; esm?: string; react?: string; note?: string };
  /** Runs before the page's blocks render. */
  beforeLoad?: EmbedAction[];
  title?: string;
  blocks: Block[];
  [k: string]: unknown;
}

export interface Connection {
  host: string;
  username: string;
  secretType: 'password' | 'secret_key';
  verifiedAt?: number;
}

export interface ProjectConfig {
  name?: string;
  thoughtSpotHost?: string;
  sdkVersion?: string;
  authType?: string;
  auth?: { tokenSource?: string; [k: string]: unknown };
  /** Cluster objects cached by the builder so an agent over MCP can read real ids. */
  catalog?: { syncedAt?: number; items: Array<{ id: string; name: string; type: string }> };
  theme?: Record<string, unknown>;
  header?: Record<string, unknown>;
  footer?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The whole app, as the one document the API speaks in. */
export interface Doc {
  projectId: string;
  config: ProjectConfig;
  pages: Record<string, Page>;
  /** Server write clock, used to notice edits made over MCP by an agent. */
  updatedAt?: number;
}

/** "3" = blocks[3]; "1.0.2" = blocks[1].columns[0].blocks[2] */
export type Loc = string;

export const ID_KEY: Record<EmbedType, string> = {
  liveboard: 'liveboardId',
  viz: 'liveboardId',
  search: 'dataSource',
  searchbar: 'dataSource',
  app: 'pageId',
  spotter: 'worksheetId',
  conversation: 'worksheetId',
};

export const METADATA_TYPE: Record<EmbedType, string | null> = {
  liveboard: 'LIVEBOARD',
  viz: 'LIVEBOARD',
  search: 'LOGICAL_TABLE',
  searchbar: 'LOGICAL_TABLE',
  app: null,
  spotter: 'LOGICAL_TABLE',
  conversation: 'LOGICAL_TABLE',
};

export const EMBED_TYPES: Array<{ type: EmbedType; label: string; blurb: string }> = [
  { type: 'liveboard', label: 'Liveboard', blurb: 'A whole liveboard, or one viz from it.' },
  { type: 'viz', label: 'Visualization', blurb: 'A single chart or table from a liveboard.' },
  { type: 'search', label: 'Search', blurb: 'The full search experience over a data source.' },
  { type: 'searchbar', label: 'Search bar', blurb: 'Just the bar, for a compact ask box.' },
  { type: 'app', label: 'Full app', blurb: 'The whole ThoughtSpot app, on a chosen page.' },
  { type: 'spotter', label: 'Spotter', blurb: 'Conversational analytics on a worksheet.' },
  { type: 'conversation', label: 'Conversation', blurb: 'The older conversational embed.' },
];

export const DEFAULT_EMBED_HEIGHT = '340px';
