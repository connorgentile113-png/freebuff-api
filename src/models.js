export const MODELS = Object.freeze([
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    aliases: ['deepseek', 'deepseek-flash'],
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    aliases: ['deepseek-pro'],
  },
  {
    id: 'minimax/minimax-m3',
    name: 'MiniMax M3',
    aliases: ['minimax', 'minimax-m3'],
  },
  {
    id: 'mimo/mimo-v2.5',
    name: 'MiMo 2.5',
    aliases: ['mimo', 'mimo-2.5'],
  },
]);

export function resolveModel(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const normalized = value.trim().toLowerCase();
  return MODELS.find(
    (model) =>
      model.id.toLowerCase() === normalized ||
      model.aliases.some((alias) => alias.toLowerCase() === normalized),
  ) ?? null;
}

