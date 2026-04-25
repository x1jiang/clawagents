/**
 * Multimodal helpers — image sanitization and friends.
 *
 *   import { sanitizeImageBlock, sanitizeToolOutput } from "clawagents/dist/media/index.js";
 *
 * or via the top-level `clawagents` namespace:
 *
 *   import { sanitizeImageBlock, sanitizeToolOutput } from "clawagents";
 */

export {
    sanitizeImageBlock,
    sanitizeToolOutput,
    isSharpAvailable,
    DEFAULT_MAX_DIM,
    DEFAULT_MAX_BYTES,
    DEFAULT_QUALITY_STEPS,
    _resetSharpCache,
} from "./images.js";

export type {
    ContentBlock,
    ImageBlock,
    ImageBlockBase64Source,
    ImageBlockUrlSource,
    SanitizeOptions,
} from "./images.js";
