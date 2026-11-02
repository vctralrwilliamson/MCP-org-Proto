import { config } from './config.js';

export async function embed(text) {
  const res = await fetch(`${config.ollama.url}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ollama.embedModel, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.embedding;
}

export async function generateAnswer(question, contextChunks) {
  const context = contextChunks
    .map((c, i) => `[${i + 1}] (source: ${c.metadata.title || c.metadata.id})\n${c.metadata.text}`)
    .join('\n\n');

  const systemPrompt = [
    'You are a support assistant that answers ONLY using the provided context.',
    'If the context does not contain the answer, say you don\'t have that information',
    'and suggest the user contact the team instead of guessing.',
    'Cite sources inline as [1], [2], etc. matching the numbered context blocks.',
  ].join(' ');

  const res = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.chatModel,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama chat failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.message?.content ?? '';
}
