export function finalText(message) {
  if (!Array.isArray(message.blocks)) return '';
  return message.blocks
    .filter((block) => block?.type === 'text' && block.textType === 'text')
    .map((block) => block.content ?? '')
    .join('')
    .trim();
}

export function terminalResponse(screen, prompt) {
  const promptIndex = screen.indexOf(prompt);
  if (promptIndex < 0) return '';
  let lines = screen.slice(promptIndex + prompt.length).split('\n');

  const footerIndex = lines.findIndex((line) =>
    /^\s*(DeepSeek|MiniMax|MiMo|GPT)[^\n]*\s·\s/.test(line),
  );
  if (footerIndex >= 0) lines = lines.slice(0, footerIndex);

  const lastThinking = lines.findLastIndex((line) => line.includes('• Thinking'));
  if (lastThinking >= 0) {
    lines = lines.slice(lastThinking + 1);
    const answerStart = lines.findIndex((line) => {
      const content = line.trim();
      const indent = line.length - line.trimStart().length;
      return content && indent <= 2 && !content.startsWith('⎘');
    });
    if (answerStart >= 0) lines = lines.slice(answerStart);
  }

  return lines
    .filter((line) => {
      const content = line.trim();
      return (
        content &&
        !content.startsWith('⎘') &&
        !content.startsWith('╭') &&
        !content.startsWith('╰') &&
        !content.startsWith('│')
      );
    })
    .map((line) => line.trimEnd().replace(/^ {0,2}/, ''))
    .join('\n')
    .trim();
}
