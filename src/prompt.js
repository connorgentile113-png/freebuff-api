function partToText(part) {
  if (typeof part === 'string') return part;
  if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
  return '';
}

export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join('\n');
  return '';
}

export function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages must be a non-empty array');
  }

  const transcript = messages.map((message, index) => {
    if (!message || typeof message.role !== 'string') {
      throw new TypeError(`messages[${index}].role must be a string`);
    }
    const content = messageText(message.content).trim();
    if (!content) throw new TypeError(`messages[${index}].content must contain text`);
    const role = message.role[0].toUpperCase() + message.role.slice(1).toLowerCase();
    return `${role}:\n${content}`;
  });

  return [
    'Treat the following as a chat transcript. Answer the latest user request. Do not modify files or run tools unless the request explicitly asks you to.',
    '',
    ...transcript,
  ].join('\n\n');
}

