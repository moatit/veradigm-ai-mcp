import WebSocket from 'ws';

/**
 * Per-leg transcription (exact speaker labels when several people are on separate legs, e.g. a warm-transfer
 * conference): one OpenAI Realtime transcription session per human leg (intent=transcription, no responses).
 * Text only goes into the call's transcript file; nothing is logged.
 */
export interface Transcriber {
  send(pcm: Buffer): void;
  close(): void;
}
export type TranscriberFactory = (rate: number, onText: (text: string) => void) => Transcriber;

/** 16 kHz -> 24 kHz (linear; for transcription only). */
export function upsample16to24(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 2);
  const outN = Math.floor((n * 3) / 2);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = (i * 2) / 3;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, n - 1);
    const f = x - i0;
    const v = pcm.readInt16LE(i0 * 2) * (1 - f) + pcm.readInt16LE(i1 * 2) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

export function openAiTranscriber(apiKey: string, WS: typeof WebSocket = WebSocket): TranscriberFactory {
  return (rate, onText) => {
    const ws = new WS('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: 8000,
    });
    let open = false;
    const pending: Buffer[] = [];
    const send = (o: unknown) => ws.readyState === WS.OPEN && ws.send(JSON.stringify(o));
    ws.on('open', () => {
      open = true;
      send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              noise_reduction: { type: 'near_field' },
              transcription: { model: process.env.VOICE_OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe', language: 'en' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
            },
          },
        },
      });
      for (const p of pending.splice(0)) send({ type: 'input_audio_buffer.append', audio: p.toString('base64') });
    });
    ws.on('message', (d: WebSocket.RawData) => {
      try {
        const m = JSON.parse(String(d));
        if (m.type === 'conversation.item.input_audio_transcription.completed' && typeof m.transcript === 'string') onText(m.transcript);
      } catch {
        // ignore
      }
    });
    ws.on('error', () => undefined);
    return {
      send(pcm: Buffer) {
        const b = rate === 16000 ? upsample16to24(pcm) : pcm;
        if (open) send({ type: 'input_audio_buffer.append', audio: b.toString('base64') });
        else if (pending.length < 100) pending.push(b);
      },
      close() {
        try {
          ws.close(1000);
        } catch {
          // ignore
        }
      },
    };
  };
}
