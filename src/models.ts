/**
 * Model name mapping between external API names and Antigravity internal IDs.
 */

export interface ModelMapping {
  id: string;             // Primary external model name
  aliases: string[];      // Alternative names that also resolve to this model
  internalId: string;     // Antigravity internal ID
  displayName: string;
  provider: string;
}

const MODEL_MAP: ModelMapping[] = [
  // Gemini models
  {
    id: 'gemini-3.1-pro',
    aliases: ['gemini-3.1-pro-high', 'gemini-pro'],
    internalId: 'MODEL_PLACEHOLDER_M37',
    displayName: 'Gemini 3.1 Pro (High)',
    provider: 'google',
  },
  {
    id: 'gemini-3.1-pro-low',
    aliases: [],
    internalId: 'MODEL_PLACEHOLDER_M36',
    displayName: 'Gemini 3.1 Pro (Low)',
    provider: 'google',
  },
  {
    id: 'gemini-3-flash',
    aliases: ['gemini-flash', 'gemini-3.0-flash'],
    internalId: 'MODEL_PLACEHOLDER_M47',
    displayName: 'Gemini 3 Flash',
    provider: 'google',
  },

  // Claude models — many alias variants for compatibility with different clients
  {
    id: 'claude-sonnet-4-20250514',
    aliases: [
      'claude-sonnet-4', 'claude-sonnet-4-6', 'claude-sonnet-4.6',
      'claude-4-sonnet', 'claude-sonnet',
      'claude-3-5-sonnet', 'claude-3.5-sonnet', 'claude-3-5-sonnet-20241022',
    ],
    internalId: 'MODEL_PLACEHOLDER_M35',
    displayName: 'Claude Sonnet 4.6 (Thinking)',
    provider: 'anthropic',
  },
  {
    id: 'claude-opus-4-20250514',
    aliases: [
      'claude-opus-4', 'claude-opus-4-6', 'claude-opus-4.6',
      'claude-4-opus', 'claude-opus',
      'claude-3-opus', 'claude-3-opus-20240229',
    ],
    internalId: 'MODEL_PLACEHOLDER_M26',
    displayName: 'Claude Opus 4.6 (Thinking)',
    provider: 'anthropic',
  },

  // OpenAI models
  {
    id: 'gpt-oss-120b',
    aliases: ['gpt-oss-120b-medium'],
    internalId: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    displayName: 'GPT-OSS 120B (Medium)',
    provider: 'openai',
  },
];

/**
 * Resolve an external model name to Antigravity internal ID.
 * Matching priority:
 *   1. Direct internal ID pass-through (MODEL_*)
 *   2. Exact match on primary id
 *   3. Exact match on aliases
 *   4. Keyword-based fuzzy match (e.g. "opus" → Opus, "sonnet" → Sonnet)
 *   5. Pass through as-is
 */
export function resolveModelId(externalName?: string): string {
  if (!externalName) return 'MODEL_PLACEHOLDER_M35'; // default: Sonnet

  // Direct internal ID pass-through
  if (externalName.startsWith('MODEL_')) return externalName;

  const name = externalName.toLowerCase().trim();

  // Exact match on primary id
  const exact = MODEL_MAP.find(m => m.id === name);
  if (exact) return exact.internalId;

  // Exact match on aliases
  const aliased = MODEL_MAP.find(m => m.aliases.some(a => a === name));
  if (aliased) return aliased.internalId;

  // Keyword-based fuzzy match
  if (name.includes('opus'))   return MODEL_MAP.find(m => m.id.includes('opus'))!.internalId;
  if (name.includes('sonnet')) return MODEL_MAP.find(m => m.id.includes('sonnet'))!.internalId;
  if (name.includes('flash'))  return MODEL_MAP.find(m => m.id.includes('flash'))!.internalId;
  if (name.includes('gemini') && name.includes('pro')) return MODEL_MAP.find(m => m.id === 'gemini-3.1-pro')!.internalId;
  if (name.includes('gpt'))    return MODEL_MAP.find(m => m.id.includes('gpt'))!.internalId;

  // Pass through as-is (might be a new model)
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

