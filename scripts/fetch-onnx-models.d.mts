export interface ReleaseOnnxModel {
  readonly id: 'silero-vad' | 'smart-turn';
  readonly filename: string;
  readonly sha256: string;
  readonly upstreamUrls: readonly string[];
}

export declare const RELEASE_ONNX_MODELS: readonly ReleaseOnnxModel[];
