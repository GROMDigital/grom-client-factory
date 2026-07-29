/**
 * EMAIL TEMPLATE COPY — the half of the customer-facing communication that lives outside the
 * workflow.
 *
 * A send-email step does not carry the email. It carries `attributes.template_id` plus
 * `templatesource: 'email-builder'`, and the HTML sits in the shared library. So the internal rail
 * reads a workflow, gets the subject, the preheader and the sender, and gets `html: undefined`.
 *
 * Measured on Grom's own UK account: 63 of 126 message steps are library templates. The copywriter
 * lane was therefore judging subject lines and cadence on half the emails and could not see a single
 * opening angle, offer or call to action in them, which is most of what a copywriter is for.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS TWO HOPS, AND WHY THE SECOND ONE IS NOT A NORMAL READ.
 *
 * VERIFIED LIVE against the UK sub-account on 2026-07-28, both hops:
 *
 *   1. `emails__fetch-template` (GET /emails/builder) returns METADATA ONLY:
 *        { builders: [{ name, updatedBy, isPlainText, lastUpdated, dateAdded,
 *                       previewUrl, id, version, templateType }],
 *          total: [{ total: 59 }] }
 *      There is no body in it, and no cursor: `limit` is the whole pagination story.
 *
 *   2. The body is at `previewUrl`, which is a Firebase storage object with a signed `token` query
 *      parameter. 200, `text/html`, ~3.5 KB, merge fields intact.
 *
 * Hop 2 is a fetch to a host that is not the GHL API, and the URL arrives IN A RESPONSE. Every other
 * read this system performs takes its host and path from a pinned descriptor precisely so that a
 * response cannot talk the collector into fetching something else, and following a response-supplied
 * URL is exactly the pattern that rule exists to block.
 *
 * So the URL is NOT followed. It is RECONSTRUCTED from values this run is already sealed with -- the
 * bound location id and the template id -- and the only thing taken from the wire is the opaque
 * `token`, which is unguessable and therefore cannot be reconstructed. A `previewUrl` pointing
 * anywhere else, at any other location, or at any other object, does not match what we rebuilt and is
 * refused rather than fetched. See `bodyUrlFor` and `TEMPLATE_OBJECT_PATH`.
 * ---------------------------------------------------------------------------------------------
 *
 * WHAT NEVER HAPPENS HERE:
 *
 *  - No credential is ever sent to the storage host. The URL is already signed, and attaching our
 *    own token would hand a GHL bearer to Google.
 *  - No redirect is followed. A 3xx is a failure, not a hop.
 *  - `updatedBy` is dropped. It is a real colleague's name and the copy does not need it.
 *  - Only templates a workflow we actually read POINTS AT are fetched. The library had 59 entries on
 *    the UK account and the workflows reference far fewer; fetching the rest would be reading
 *    material nothing sends.
 */
import { canonicalJson, sha256 } from '../canonical.mjs';

export const EMAIL_COPY_SCHEMA = '1.0.0';

/** The one action this module may call, and it is in the checked-in read allowlist. */
export const EMAIL_TEMPLATE_ACTION = 'emails__fetch-template';

/** The one host a body may come from. Anything else is refused before a socket is opened. */
export const TEMPLATE_BODY_HOST = 'firebasestorage.googleapis.com';

/**
 * The storage object path, as OBSERVED. `location/<locationId>/emails/<templateId>/index.html`,
 * percent-encoded into a single Firebase object name.
 */
function templateObjectPath(locationId, templateId) {
  return `/v0/b/highlevel-backend.appspot.com/o/${
    encodeURIComponent(`location/${locationId}/emails/${templateId}/index.html`)
  }`;
}

/** A GHL object id. Narrow, because it goes into a URL we then fetch. */
const OBJECT_ID = /^[A-Za-z0-9]{8,64}$/u;

/** The signed token. Opaque, so it is bounded by shape and length rather than understood. */
const SIGNED_TOKEN = /^[A-Za-z0-9._~-]{8,256}$/u;

const DEFAULT_BUDGETS = Object.freeze({
  // 59 templates on the UK account and one page holds them. Two pages is slack, not ambition.
  maxListPages: 3,
  listPageLimit: 100,
  // More than this many distinct templates behind one account's workflows means something is wrong
  // with the id extraction rather than the account.
  maxBodies: 120,
  // A marketing email. The largest in the Grom library is under 40 KB.
  maxBodyBytes: 512 * 1024,
  bodyTimeoutMs: 20000,
});

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every distinct library template id the workflows actually point at.
 *
 * Read off the SAME workflow exports lane 2 is built from, so a template can only be fetched because
 * a step we have in hand names it. `templatesource` is the runtime discriminator between a
 * template-mode step and an inline one; `template_id` alone is not, because a step converted to
 * inline keeps a stale id.
 */
export function templateIdsFromWorkflows(workflows) {
  const ids = new Set();
  for (const { attributes } of sendingSteps(workflows)) {
    // An inline step carries its own `html` and needs nothing from the library.
    if (typeof attributes.html === 'string' && attributes.html.length > 0) continue;
    const id = attributes.template_id;
    if (typeof id === 'string' && OBJECT_ID.test(id)) ids.add(id);
  }
  return [...ids].sort(byteOrder);
}

/**
 * Every step that sends an email, with its content fields brought to one level.
 *
 * TWO SHAPES, and reading only the first loses every internal notification's body. A normal `email`
 * step keeps `template_id`, `html` and `subject` directly on `attributes`. An `internal_notification`
 * keeps `attributes` as `{type, email}` and puts all of that inside `attributes.email`. Verified
 * against four live exports 2026-07-29.
 *
 * Internal notifications are collected because a template-backed one is otherwise unreadable
 * downstream, and a staff alert that promises a sanction nothing carries out is a real finding.
 */
function* sendingSteps(workflows) {
  for (const workflow of Array.isArray(workflows) ? workflows : []) {
    const templates = workflow?.definition?.data?.workflow?.workflowData?.templates;
    for (const step of Array.isArray(templates) ? templates : []) {
      if (step?.type !== 'email' && step?.type !== 'internal_notification') continue;
      const outer = isPlainObject(step.attributes) ? step.attributes : {};
      const attributes = step.type === 'internal_notification'
        ? (isPlainObject(outer.email) ? outer.email : {})
        : outer;
      yield { step, attributes };
    }
  }
}

/**
 * The `previewUrl` each send step carries for its own template, keyed by template id.
 *
 * The library index is not the only place a signed URL for a template appears: the step that SENDS
 * it carries one too. That matters for a template a workflow points at which the index does not
 * list at all, because the index is then not a second opinion, it is simply silent.
 *
 * OBSERVED on the UK sub-account 2026-07-29: `001 - FB Lead Form` step "Email 4 - Diagnosis" points
 * at a template id that appears in NEITHER the 55-entry root listing NOR the full 73. Its stored
 * object is still there and still readable, and its bytes are identical to a template that IS in the
 * library, so the library RECORD was deleted while the content and the reference both survived. The
 * email still sends. Without this fallback the audit reads that email as unjudgeable, which is the
 * account's most-sent lead email.
 *
 * This is not a loosening of the security rule in the header. The URL is not followed: it is handed
 * to `bodyUrlFor` exactly as a library one is, and rebuilt from the sealed location id and template
 * id with only the opaque token taken from it. A step pointing at another location's object fails
 * the same path check and is refused.
 */
export function templatePreviewUrlsFromWorkflows(workflows) {
  const urls = new Map();
  for (const { attributes } of sendingSteps(workflows)) {
    if (typeof attributes.html === 'string' && attributes.html.length > 0) continue;
    const id = attributes.template_id;
    const previewUrl = attributes.previewUrl;
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) continue;
    if (typeof previewUrl !== 'string' || previewUrl.length === 0) continue;
    if (!urls.has(id)) urls.set(id, previewUrl);
  }
  return urls;
}

/**
 * Rebuild the body URL from sealed values, taking ONLY the signed token from the supplied one.
 *
 * This is the whole security argument of this module. Returns `null` rather than throwing when the
 * supplied URL does not describe the object we expect, because one odd template must degrade to
 * "body unavailable" and not kill the run.
 */
export function bodyUrlFor({ locationId, templateId, previewUrl }) {
  if (typeof previewUrl !== 'string' || previewUrl.length === 0) return null;
  if (!OBJECT_ID.test(templateId)) return null;
  let parsed;
  try {
    parsed = new URL(previewUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== TEMPLATE_BODY_HOST) return null;
  // The path must be the object THIS location's THIS template lives at. A previewUrl for another
  // location or another object does not match and is never fetched.
  if (decodeURIComponent(parsed.pathname) !== decodeURIComponent(templateObjectPath(locationId, templateId))) {
    return null;
  }
  const token = parsed.searchParams.get('token');
  if (typeof token !== 'string' || !SIGNED_TOKEN.test(token)) return null;
  // Rebuilt from scratch, so no other query parameter the response carried survives.
  const rebuilt = new URL(`https://${TEMPLATE_BODY_HOST}${templateObjectPath(locationId, templateId)}`);
  rebuilt.searchParams.set('alt', 'media');
  rebuilt.searchParams.set('token', token);
  return rebuilt.toString();
}

/** The default body reader. Isolated so a test never opens a socket. */
async function fetchBodyOverHttps(url, { timeoutMs, maxBytes, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: 'GET',
      // A 3xx is a failure. The point of rebuilding the URL is that we know exactly what we asked
      // for, and a redirect would hand the destination back to whoever answers.
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'text/html' },
    });
    if (!response.ok) throw codedError('EMAIL_TEMPLATE_BODY_STATUS');
    const text = await response.text();
    if (text.length > maxBytes) throw codedError('EMAIL_TEMPLATE_BODY_TOO_LARGE');
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * The list hop, through the worker, stamped with the same policy block every governed read carries.
 *
 * It does NOT go through the journey collector. That collector's request is fixed at
 * `{locationId, fromDate, toDate, cursor}` because every journey read is a windowed time series;
 * this endpoint is neither windowed nor cursor-paged, and forcing it through that shape would mean
 * either sending parameters it does not have or widening the one function every journey read passes
 * through. The approval that matters -- the allowlist entry -- is shared.
 */
function listRequest(capability, locationId, limit, offset, dialect) {
  /*
   * `templatesOnly` IS NOT OPTIONAL, and leaving it off silently loses every foldered template.
   *
   * VERIFIED LIVE on the UK sub-account 2026-07-29. Without it the index is a DIRECTORY LISTING of
   * the library ROOT: it returns folders as entries alongside templates. That account answered with
   * 60 entries, five of which were folders, so 55 templates were visible and the 18 sitting in the
   * "V2 Onboarding" folder were not. With the flag the same endpoint returns 73, all templates.
   *
   * The cost of the omission was invisible because a foldered template is INDISTINGUISHABLE, at the
   * matching step below, from one that does not exist: both are simply absent from `listed` and both
   * were reported as NOT_IN_SHARED_LIBRARY. On the 2026-07-27 Grom UK run that was 19 of 81 emails,
   * and because the delivery ladders are the part of that account that keeps its copy in a folder,
   * every one of the unreadable emails was a client-facing onboarding email. The copywriter lane
   * judged them on subject lines alone and said so.
   */
  const params = { locationId, limit, offset, templatesOnly: 'true' };
  /*
   * TWO DIALECTS, and picking the wrong one is a live-only failure that no hermetic double catches.
   *
   * `native` is the worker's OWN tool contract, `{action_id, params}`. `bounded` is this repo's
   * normalised dialect, `{action, params, policy}`, which `lib/adapters/ghl-public-translator.mjs`
   * converts into the native one.
   *
   * The first live run of this module sent `bounded` down a NATIVE transport, where the translating
   * connect sits in front of the client and knows only the seven journey reads. It refused the call
   * with the very rule this module added to it -- `emails__fetch-template` is listed in
   * `NOT_COLLECTABLE_IN_THIS_SHAPE` -- and the copy came back empty with `MCP_TOOL_CALL_FAILED`.
   * That refusal is correct and stays. This rail simply must not be behind the translator: it is
   * not a journey read, so it speaks to the worker directly, in the worker's own dialect.
   */
  if (dialect === 'native') {
    return { name: 'execute_action', arguments: { action_id: EMAIL_TEMPLATE_ACTION, params } };
  }
  return {
    name: 'execute_action',
    arguments: {
      action: EMAIL_TEMPLATE_ACTION,
      params,
      policy: {
        actionId: capability.actionId,
        method: capability.method,
        normalizedPath: capability.normalizedPath,
        category: capability.category,
        risk: capability.risk,
        sourceSnapshotHash: capability.sourceSnapshotHash,
        allowlistHash: capability.allowlistHash,
        providerId: capability.providerId,
        capabilityManifestHash: capability.capabilityManifestHash,
      },
    },
  };
}

/**
 * The payload inside the worker's response envelope.
 *
 * OBSERVED: the worker answers `{ ok, status, data, note, filter, pagination, error }` and the GHL
 * body is at `.data`. The first live run read one level too shallow, found no `builders`, and
 * reported `EMAIL_TEMPLATE_LIST_SHAPE` against a perfectly good 200. Both depths are accepted so a
 * host that injects an already-unwrapped delegate still works, but the envelope is tried FIRST.
 */
function bodyOf(response) {
  const outer = response?.structuredContent ?? response;
  if (!isPlainObject(outer)) return null;
  if (isPlainObject(outer.data) && Array.isArray(outer.data.builders)) return outer.data;
  return isPlainObject(outer) ? outer : null;
}

/**
 * Metadata for one library template, reduced to what judging copy needs.
 *
 * `updatedBy` is deliberately absent: it is a colleague's name, it reaches the analysis briefs, and
 * no judgement about an email depends on who last touched it.
 */
function templateRecord(entry) {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || !OBJECT_ID.test(entry.id)) return null;
  return {
    templateId: entry.id,
    name: typeof entry.name === 'string' ? entry.name : null,
    templateType: typeof entry.templateType === 'string' ? entry.templateType : null,
    isPlainText: entry.isPlainText === true,
    lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : null,
    previewUrl: typeof entry.previewUrl === 'string' ? entry.previewUrl : null,
  };
}

/**
 * Collect the copy of every library template the supplied workflows point at.
 *
 * Fails SOFT and says so. A template that cannot be listed, matched or fetched becomes a stated
 * limitation and a body of `null`; the brief then tells the analyst it is judging that email on
 * subject and placement only. That is the honest degradation: an unreadable email must never look
 * like an empty one.
 */
export function createEmailCopyCollector({
  client,
  capability,
  boundLocationId,
  // Which request contract the supplied client speaks. `native` is the worker's own
  // `{action_id, params}`; `bounded` is this repo's normalised `{action, params, policy}`. See
  // `listRequest`: sending the wrong one is a live-only failure, and it happened on the first run.
  dialect = 'bounded',
  budgets = {},
  fetchBody = fetchBodyOverHttps,
} = {}) {
  if (
    typeof client?.callTool !== 'function'
    || !isPlainObject(capability)
    || capability.actionId !== EMAIL_TEMPLATE_ACTION
    || typeof boundLocationId !== 'string'
    || boundLocationId.length === 0
    || (dialect !== 'native' && dialect !== 'bounded')
  ) throw codedError('EMAIL_COPY_CONFIG_INVALID', TypeError);
  const limits = { ...DEFAULT_BUDGETS, ...budgets };

  return {
    async collectEmailCopy({ workflows, signal } = {}) {
      const limitations = new Set();
      const wanted = templateIdsFromWorkflows(workflows);
      const stepPreviewUrls = templatePreviewUrlsFromWorkflows(workflows);
      if (wanted.length === 0) {
        return Object.freeze({
          schemaVersion: EMAIL_COPY_SCHEMA,
          boundLocationId,
          complete: true,
          limitations: Object.freeze([]),
          requestedCount: 0,
          templates: Object.freeze([]),
          templatesHash: sha256([]),
        });
      }

      // ---- hop 1: the library index -------------------------------------------------------
      const listed = new Map();
      let pages = 0;
      let libraryTotal = null;
      try {
        for (; pages < limits.maxListPages; pages += 1) {
          const response = await client.callTool(
            listRequest(capability, boundLocationId, limits.listPageLimit, pages * limits.listPageLimit, dialect),
            { signal },
          );
          const body = bodyOf(response);
          const builders = Array.isArray(body?.builders) ? body.builders : null;
          if (builders === null) throw codedError('EMAIL_TEMPLATE_LIST_SHAPE');
          // OBSERVED: `total: [{ total: 59 }]`. An array holding one object, not a number.
          const reported = Array.isArray(body.total) ? body.total[0]?.total : body.total;
          if (typeof reported === 'number' && Number.isInteger(reported)) libraryTotal = reported;
          for (const entry of builders) {
            const record = templateRecord(entry);
            if (record !== null && !listed.has(record.templateId)) listed.set(record.templateId, record);
          }
          if (builders.length < limits.listPageLimit) break;
        }
        if (pages >= limits.maxListPages) limitations.add('EMAIL_TEMPLATE_LIST_PAGE_BUDGET_EXHAUSTED');
      } catch (error) {
        // The list is the whole hop. Without it nothing can be matched, so the run keeps its
        // workflows and states that the copy is missing rather than dying.
        return Object.freeze({
          schemaVersion: EMAIL_COPY_SCHEMA,
          boundLocationId,
          complete: false,
          limitations: Object.freeze([...limitations, boundedCode(error)]),
          requestedCount: wanted.length,
          templates: Object.freeze([]),
          templatesHash: sha256([]),
        });
      }

      // ---- hop 2: the bodies ---------------------------------------------------------------
      const templates = [];
      let fetched = 0;
      for (const templateId of wanted) {
        const record = listed.get(templateId);
        if (record === undefined) {
          /*
           * A template id a workflow points at that the index does not list. Since `templatesOnly`
           * was added to the list request this is genuinely rare, and it now means the library
           * RECORD is gone rather than merely filed in a folder.
           *
           * The step that sends it still carries a signed URL for the object, so try that before
           * giving up. Same verification path as a library body: rebuilt, never followed.
           */
          const orphan = {
            templateId,
            name: null,
            templateType: null,
            isPlainText: false,
            lastUpdated: null,
          };
          const orphanUrl = bodyUrlFor({
            locationId: boundLocationId,
            templateId,
            previewUrl: stepPreviewUrls.get(templateId),
          });
          if (orphanUrl === null || fetched >= limits.maxBodies) {
            templates.push({ ...orphan, body: null, bodyUnavailable: 'NOT_IN_SHARED_LIBRARY' });
            limitations.add('EMAIL_TEMPLATE_NOT_IN_SHARED_LIBRARY');
            continue;
          }
          fetched += 1;
          try {
            const html = await fetchBody(orphanUrl, {
              timeoutMs: limits.bodyTimeoutMs,
              maxBytes: limits.maxBodyBytes,
              signal,
            });
            /*
             * Readable, but the library cannot name it or date it. Say so rather than letting a
             * nameless template read as an ordinary one: a reviewer who sees the copy should also
             * see that nothing in the library governs it any more.
             */
            templates.push({ ...orphan, body: String(html ?? ''), bodyUnavailable: null, unlistedInLibrary: true });
            limitations.add('EMAIL_TEMPLATE_RECOVERED_UNLISTED');
          } catch (error) {
            templates.push({ ...orphan, body: null, bodyUnavailable: boundedCode(error) });
            limitations.add('EMAIL_TEMPLATE_NOT_IN_SHARED_LIBRARY');
          }
          continue;
        }
        if (fetched >= limits.maxBodies) {
          templates.push({ ...withoutPreviewUrl(record), body: null, bodyUnavailable: 'BODY_BUDGET_EXHAUSTED' });
          limitations.add('EMAIL_TEMPLATE_BODY_BUDGET_EXHAUSTED');
          continue;
        }
        const url = bodyUrlFor({ locationId: boundLocationId, templateId, previewUrl: record.previewUrl });
        if (url === null) {
          // The supplied URL did not describe this location's copy of this template. Refused, not
          // followed. See the header: this is the one check that makes hop 2 safe.
          templates.push({ ...withoutPreviewUrl(record), body: null, bodyUnavailable: 'PREVIEW_URL_UNVERIFIED' });
          limitations.add('EMAIL_TEMPLATE_PREVIEW_URL_UNVERIFIED');
          continue;
        }
        fetched += 1;
        try {
          const html = await fetchBody(url, {
            timeoutMs: limits.bodyTimeoutMs,
            maxBytes: limits.maxBodyBytes,
            signal,
          });
          templates.push({ ...withoutPreviewUrl(record), body: String(html ?? ''), bodyUnavailable: null });
        } catch (error) {
          templates.push({ ...withoutPreviewUrl(record), body: null, bodyUnavailable: boundedCode(error) });
          limitations.add('EMAIL_TEMPLATE_BODY_UNREADABLE');
        }
      }

      templates.sort((left, right) => byteOrder(left.templateId, right.templateId));
      return Object.freeze({
        schemaVersion: EMAIL_COPY_SCHEMA,
        boundLocationId,
        complete: limitations.size === 0,
        limitations: Object.freeze([...limitations].sort(byteOrder)),
        requestedCount: wanted.length,
        libraryTotal,
        templates: Object.freeze(templates),
        templatesHash: sha256(canonicalJson(templates)),
      });
    },
  };
}

/**
 * The signed URL never travels onward. It is a credential for the object, it appears in every
 * artefact the record reaches, and nothing downstream fetches anything.
 */
function withoutPreviewUrl(record) {
  const { previewUrl: _dropped, ...rest } = record;
  return rest;
}

/** An UPPER_SNAKE code or nothing. Error messages here can carry a signed URL. */
function boundedCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code)
    ? code
    : 'EMAIL_TEMPLATE_COLLECTION_FAILED';
}
