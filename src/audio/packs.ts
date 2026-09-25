import { getFile, listKits, type UserKit } from '../core/library';
import { KIT_BY_ID, KITS, registerKit, type KitDef } from './drums';

/** A stored drum pack as a kit: its recordings, with the Trap kit's synthesized voices for the rest. */
export function userKitDef(k: UserKit): KitDef {
  const fb = KIT_BY_ID.get('trap') ?? KITS[0];
  return { id: k.id, label: k.name, group: 'Your packs', voices: fb.voices, fallback: fb.id, samples: { fetch: getFile, files: k.files } };
}

/** Register every pack saved in this browser (call once at startup, before loading kits). */
export async function restoreUserKits(): Promise<void> {
  try {
    for (const k of await listKits()) registerKit(userKitDef(k));
  } catch {
    /* no storage: nothing to restore */
  }
}
