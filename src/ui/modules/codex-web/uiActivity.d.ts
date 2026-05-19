export interface UiActivitySnapshot {
  kind: string;
  fields: Record<string, unknown>;
  startedAtUnixMs: number;
  depth: number;
}

export declare function beginUiActivity(
  windowRef: Window | null | undefined,
  kind: string,
  fields?: Record<string, unknown>
): () => void;

export declare function readUiActivitySnapshot(
  windowRef: Window | null | undefined
): UiActivitySnapshot | null;
