import { randomBase62 } from "./keys.js";

export const newLogId = () => `norm_${randomBase62(24)}`;
export const newKeyId = () => `key_${randomBase62(24)}`;
export const newEntryId = () => `al_${randomBase62(24)}`;
