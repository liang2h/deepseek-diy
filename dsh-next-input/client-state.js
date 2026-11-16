/** Pure client-side guards. No draft writes occur until an explicit click. */
export function isEmptyEditable(input) {
  return input?.phase === 'plain' && input.draft === '' && Array.isArray(input.attachmentIds) && input.attachmentIds.length === 0;
}

export function canOffer({cursor, session, input, allowed = true}) {
  return allowed && cursor?.eligible === true && Number.isSafeInteger(cursor.endSeq) && cursor.endSeq >= 0
    && session?.openState === 'open' && !session.running && !session.removed && !session.subagent
    && !(session.pendingSubmissions?.length > 0) && isEmptyEditable(input);
}

/** Compare the current editor revision, not the one visible when a model call started. */
export function acceptSuggestion({text, expectedRev, getInput, actions}) {
  if (typeof text !== 'string' || !text.trim() || !actions || !Number.isSafeInteger(expectedRev)) return false;
  const current = getInput();
  if (!isEmptyEditable(current) || current.draftRev !== expectedRev) return false;
  const span = actions.captureInsertion();
  if (span.draftRev !== expectedRev || span.start !== 0 || span.end !== 0) return false;
  const latest = getInput();
  if (!isEmptyEditable(latest) || latest.draftRev !== expectedRev) return false;
  return actions.insertText(text, span) === true;
}

/** The view consumes an unwrapped reply only, never a RemoteResult envelope. */
export function suggestionText({reply, key, visible}) {
  return visible && reply?.key === key && reply.status === 'ready' && typeof reply.suggestion === 'string' && reply.suggestion.trim()
    ? reply.suggestion : null;
}

/** Per-Client bounded deduplication; a settled empty/error response also suppresses repeats. */
export function createSuggestionCache(limit = 128) {
  const entries = new Map();
  return {
    get(key) {return entries.get(key);},
    remember(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return value;
    },
    clear() {entries.clear();},
  };
}
