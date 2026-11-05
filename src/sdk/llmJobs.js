export const LLM_REASON = Object.freeze({
  NO_PROVIDER: 'no-provider',
  BAD_PROMPT: 'bad-prompt',
  BAD_CONVERSATION: 'bad-conversation',
  PROVIDER_THREW: 'provider-threw',
  PART_HANDLER_THREW: 'part-handler-threw',
  CANCELLED: 'cancelled',
  EMPTY_REPLY: 'empty-reply',
});

const DEFAULT_MAX_MESSAGES = 32;
const DEFAULT_MAX_PROMPT_CHARS = 8000;

function fail(reasonCode, message) {
  return { ok: false, reasonCode, message };
}

function assertProvider(provider) {
  if (provider == null) return null;
  if (typeof provider.complete !== 'function') throw new TypeError('[llm] provider.complete must be a function');
  return provider;
}

function boundedMessages(messages, max) {
  return messages.length > max ? messages.slice(messages.length - max) : messages;
}

export function createLlmJobs({ provider = null, maxMessages = DEFAULT_MAX_MESSAGES, maxPromptChars = DEFAULT_MAX_PROMPT_CHARS } = {}) {
  if (!Number.isInteger(maxMessages) || maxMessages < 2) throw new RangeError(`[llm] maxMessages must be an integer >= 2, got ${maxMessages}`);
  if (!Number.isInteger(maxPromptChars) || maxPromptChars < 1) throw new RangeError(`[llm] maxPromptChars must be a positive integer, got ${maxPromptChars}`);
  let active = assertProvider(provider);
  const conversations = new Map();
  let nextJobId = 1;
  const jobs = new Map();

  function conversationFor(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    let convo = conversations.get(id);
    if (!convo) conversations.set(id, convo = { messages: [] });
    return convo;
  }

  function start({ conversation, prompt, onPart = null, system = null } = {}) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > maxPromptChars) {
      return finished(fail(LLM_REASON.BAD_PROMPT, `prompt must be a non-empty string of at most ${maxPromptChars} characters`));
    }
    if (onPart !== null && typeof onPart !== 'function') return finished(fail(LLM_REASON.BAD_PROMPT, 'onPart must be a function or null'));
    const convo = conversationFor(conversation);
    if (conversation !== undefined && conversation !== null && !convo) return finished(fail(LLM_REASON.BAD_CONVERSATION, 'conversation must be a non-empty string id'));
    if (!active) return finished(fail(LLM_REASON.NO_PROVIDER, 'no llm provider is configured for this runtime'));

    const id = nextJobId++;
    const controller = new AbortController();
    const history = convo ? convo.messages.slice() : [];
    const request = {
      system,
      messages: [...history, { role: 'user', content: prompt }],
      signal: controller.signal,
    };
    const job = { id, cancelled: false, cancel: () => { job.cancelled = true; controller.abort(); } };
    jobs.set(id, job);
    job.done = run(request, convo, prompt, onPart, job).finally(() => jobs.delete(id));
    return job;
  }

  async function run(request, convo, prompt, onPart, job) {
    let text = '';
    let partError = null;
    const deliver = (chunk) => {
      if (typeof chunk !== 'string' || partError) return;
      text += chunk;
      if (!onPart) return;
      try { onPart(chunk) } catch (err) { partError = err }
    };
    try {
      const reply = await active.complete({ ...request, onPart: deliver });
      if (job.cancelled) return fail(LLM_REASON.CANCELLED, 'job was cancelled');
      if (partError) return fail(LLM_REASON.PART_HANDLER_THREW, String(partError?.message ?? partError));
      const finalText = typeof reply === 'string' ? reply : (typeof reply?.text === 'string' ? reply.text : text);
      if (finalText.length === 0) return fail(LLM_REASON.EMPTY_REPLY, 'provider returned no text');
      if (convo) convo.messages = boundedMessages([...convo.messages, { role: 'user', content: prompt }, { role: 'assistant', content: finalText }], maxMessages);
      return { ok: true, text: finalText };
    } catch (err) {
      if (job.cancelled || err?.name === 'AbortError') return fail(LLM_REASON.CANCELLED, 'job was cancelled');
      return fail(LLM_REASON.PROVIDER_THREW, String(err?.message ?? err));
    }
  }

  function finished(result) {
    return { id: 0, cancelled: false, cancel: () => {}, done: Promise.resolve(result) };
  }

  function setProvider(next) {
    active = assertProvider(next);
  }

  function history(conversation) {
    const convo = conversations.get(conversation);
    return convo ? convo.messages.map(m => ({ ...m })) : [];
  }

  function reset(conversation) {
    if (conversation === undefined) { conversations.clear(); return; }
    conversations.delete(conversation);
  }

  function dispose() {
    for (const job of jobs.values()) job.cancel();
    jobs.clear();
    conversations.clear();
    active = null;
  }

  return Object.freeze({ start, history, reset, setProvider, dispose });
}
