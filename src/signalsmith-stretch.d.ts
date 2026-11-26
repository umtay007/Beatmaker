declare module '*/vendor/signalsmith-stretch.mjs' {
  export interface StretchNode extends AudioNode {
    schedule(change: { output?: number; active?: boolean; input?: number; rate?: number; semitones?: number; loopStart?: number; loopEnd?: number }): void;
    addBuffers(channels: Float32Array[]): Promise<number>;
    dropBuffers(): Promise<unknown>;
    latency(): number;
  }
  export default function SignalsmithStretch(ctx: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
}
