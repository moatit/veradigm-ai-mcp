/**
 * One hosted speech-to-speech model behind one interface (OpenAI Realtime, ElevenLabs Conversational AI, fakes in
 * tests). Audio is PCM s16le mono at `pcmRate` both ways. The provider never sees a call ID it could choose:
 * tool calls come back to the orchestrator, which runs them under the call ID Drawbridge minted.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: any;
}

export interface ProviderInit {
  model: string;
  voice: string;
  instructions: string;
  tools: ToolSpec[];
  language: string;
  turn: { vad: 'semantic_vad' | 'server_vad'; eagerness: string; silence_ms: number };
  /** ElevenLabs: the agent ID that carries tools and settings. */
  agentId?: string;
  /** Dynamic values (line mode, records status, time). */
  vars: Record<string, string>;
}

export interface ProviderEvents {
  /** Agent audio for the current response. */
  audio(pcm: Buffer, responseId: string): void;
  agentTranscript(text: string, final: boolean, responseId: string): void;
  /** The caller's words (the model's input transcription; final only). */
  callerTranscript(text: string): void;
  /** The provider heard the caller start talking (barge-in). */
  speechStarted(): void;
  speechStopped(): void;
  toolCall(call: { id: string; name: string; args: any }): void;
  responseStarted(responseId: string): void;
  responseDone(responseId: string, status: 'completed' | 'cancelled' | 'failed' | 'incomplete'): void;
  error(code: string, fatal: boolean): void;
  closed(code: string): void;
}

export interface VoiceProvider {
  readonly name: 'openai' | 'elevenlabs' | 'fake';
  readonly pcmRate: number;
  connect(init: ProviderInit, events: ProviderEvents): Promise<void>;
  sendAudio(pcm: Buffer): void;
  /** Return a tool's output; respond=true asks the model to continue. */
  sendToolResult(callId: string, output: string, respond: boolean): void;
  /** A line we played ourselves (scripted clip): goes into the model's history as the assistant's words. */
  addAssistantText(text: string): void;
  /** A note from the orchestrator (transfer failed, staff on the line, ...). respond=true: the model speaks next. */
  addSystemNote(text: string, respond: boolean): void;
  /** The caller cut the agent off after `playedMs` of the current response (truncates its history). */
  truncate(responseId: string, playedMs: number): void;
  cancelResponse(): void;
  requestResponse(): void;
  close(): void;
}
