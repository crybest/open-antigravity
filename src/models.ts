/**
 * Model name mapping between external API names and Antigravity internal IDs.
 */

export interface ModelMapping {
  id: string;             // External model name (OpenAI/Anthropic style)
  internalId: string;     // Antigravity internal ID
  displayName: string;
  provider: string;
}

const MODEL_MAP: ModelMapping[] = [
  // Gemini models
  { id: 'gemini-3.1-pro',       internalId: 'MODEL_PLACEHOLDER_M37', displayName: 'Gemini 3.1 Pro (High)',  provider: 'google' },
  { id: 'gemini-3.1-pro-low',   internalId: 'MODEL_PLACEHOLDER_M36', displayName: 'Gemini 3.1 Pro (Low)',   provider: 'google' },
  { id: 'gemini-3-flash',       internalId: 'MODEL_PLACEHOLDER_M84', displayName: 'Gemini 3 Flash',         provider: 'google' },

  // Claude models
  { id: 'claude-sonnet-4-20250514',     internalId: 'MODEL_PLACEHOLDER_M35', displayName: 'Claude Sonnet 4.6 (Thinking)',  provider: 'anthropic' },
  { id: 'claude-opus-4-20250514',       internalId: 'MODEL_PLACEHOLDER_M26', displayName: 'Claude Opus 4.6 (Thinking)',    provider: 'anthropic' },

  // OpenAI models
  { id: 'gpt-oss-120b',         internalId: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', displayName: 'GPT-OSS 120B (Medium)', provider: 'openai' },
];

/**
 * Resolve an external model name to Antigravity internal ID.
 * Falls back to the raw model string if no mapping found (allows direct internal IDs too).
 */
export function resolveModelId(externalName?: string): string {
  if (!externalName) return 'MODEL_PLACEHOLDER_M35'; // default: Sonnet

  // Direct internal ID pass-through
  if (externalName.startsWith('MODEL_')) return externalName;

  const name = externalName.toLowerCase();

  // Exact match first
  const exact = MODEL_MAP.find(m => m.id === externalName);
  if (exact) return exact.internalId;

  // Family-based matching — handles any version suffix (e.g. claude-opus-4-6, claude-opus-4-20250514)
  if (name.includes('opus'))   return 'MODEL_PLACEHOLDER_M26'; // Claude Opus
  if (name.includes('sonnet')) return 'MODEL_PLACEHOLDER_M35'; // Claude Sonnet
  if (name.includes('haiku'))  return 'MODEL_PLACEHOLDER_M35'; // No Haiku → fall back to Sonnet
  if (name.includes('claude')) return 'MODEL_PLACEHOLDER_M35'; // Any other Claude → Sonnet

  if (name.includes('gemini-3.1') || name.includes('gemini-pro')) return 'MODEL_PLACEHOLDER_M37';
  if (name.includes('gemini-3-flash') || name.includes('gemini-flash')) return 'MODEL_PLACEHOLDER_M84';
  if (name.includes('gemini')) return 'MODEL_PLACEHOLDER_M37'; // Any other Gemini → Pro High

  if (name.includes('gpt')) return 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM';

  // Pass through as-is (might be a new internal ID)
  console.log(`⚠️  Unknown model "${externalName}", passing through as-is`);
  return externalName;
}

/**
 * Get all available model mappings.
 */
export function getAllModels(): ModelMapping[] {
  return MODEL_MAP;
}

/**
 * Format models as OpenAI /v1/models response.
 */
export function toOpenAIModelsResponse() {
  return {
    object: 'list',
    data: MODEL_MAP.map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: m.provider,
    })),
  };
}
