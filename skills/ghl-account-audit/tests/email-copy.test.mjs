/**
 * EMAIL TEMPLATE COPY.
 *
 * Every response shape asserted here was OBSERVED live against the UK sub-account on 2026-07-28,
 * both hops. `GET /emails/builder` returns `{builders: [...], total: [{total: 59}]}` with a
 * `previewUrl` and no body; the body is at that URL, `text/html`, with merge fields intact.
 *
 * The property these tests exist to defend is the URL pin. Hop 2 fetches a host that is not the GHL
 * API, using a URL that arrived IN A RESPONSE, and every other read in this system takes its host and
 * path from a pinned descriptor for exactly that reason. So the URL is rebuilt from the sealed
 * location and template id, and only the unguessable signed token is taken from the wire.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TEMPLATE_BODY_HOST,
  bodyUrlFor,
  createEmailCopyCollector,
  templateIdsFromWorkflows,
} from '../lib/adapters/email-copy.mjs';

const LOCATION = 'yoQVVJFp6wyjxcxilA2H';
const TEMPLATE = '6a2c675152ce94e124f9f0f1';
const OTHER_TEMPLATE = '6a1707ff4a531d4a18de4bf9';
const TOKEN = 'ff98adba-99cb-488a-b244-bda8397c02cd';

/** The real previewUrl shape, verbatim from the live response. */
function previewUrl(locationId = LOCATION, templateId = TEMPLATE, token = TOKEN) {
  return `https://firebasestorage.googleapis.com/v0/b/highlevel-backend.appspot.com/o/${
    encodeURIComponent(`location/${locationId}/emails/${templateId}/index.html`)
  }?alt=media&token=${token}`;
}

/** A workflow export with one email step, in the shape `export_workflow` really returns. */
function workflow(steps) {
  return {
    workflowId: 'wf-1',
    definition: {
      data: {
        workflow: {
          _id: 'wf-1',
          name: '08 Long Term Nurture',
          workflowData: { templates: steps.map((step, index) => ({ order: index, ...step })) },
        },
        triggers: [],
      },
    },
  };
}

const capability = Object.freeze({
  actionId: 'emails__fetch-template',
  method: 'GET',
  normalizedPath: '/emails/builder',
  category: 'emails',
  risk: 'read',
  sourceSnapshotHash: 'a'.repeat(64),
  allowlistHash: 'b'.repeat(64),
  providerId: 'provider-1',
  capabilityManifestHash: 'c'.repeat(64),
});

/** A worker double returning the OBSERVED envelope. */
function listClient(builders, { total = builders.length, calls = [] } = {}) {
  return {
    callTool: async (request) => {
      calls.push(request);
      return {
        structuredContent: {
          builders,
          // OBSERVED: an ARRAY holding one object, not a number.
          total: [{ total }],
        },
      };
    },
    calls,
  };
}

function builder(templateId, name, { location = LOCATION, token = TOKEN } = {}) {
  return {
    name,
    updatedBy: 'A Real Person',
    isPlainText: false,
    lastUpdated: '2026-06-12T20:08:51.575Z',
    dateAdded: '2026-06-12T20:08:50.232Z',
    previewUrl: previewUrl(location, templateId, token),
    id: templateId,
    version: '2',
    templateType: 'html',
  };
}

function collector(client, { fetchBody, budgets } = {}) {
  return createEmailCopyCollector({
    client,
    capability,
    boundLocationId: LOCATION,
    ...(fetchBody ? { fetchBody } : { fetchBody: async () => '<p>Hi {{contact.first_name}}</p>' }),
    ...(budgets ? { budgets } : {}),
  });
}

// ---- which templates get read --------------------------------------------

test('only templates a send step actually points at are read', () => {
  const ids = templateIdsFromWorkflows([workflow([
    { type: 'email', attributes: { template_id: TEMPLATE, templatesource: 'email-builder' } },
    { type: 'sms', attributes: { message: 'hi' } },
    // Inline: it carries its own html and needs nothing from the library.
    { type: 'email', attributes: { template_id: OTHER_TEMPLATE, html: '<p>inline</p>' } },
  ])]);
  assert.deepEqual(ids, [TEMPLATE]);
});

test('an id that is not a plausible object id is never turned into a URL', () => {
  const ids = templateIdsFromWorkflows([workflow([
    { type: 'email', attributes: { template_id: '../../etc/passwd' } },
    { type: 'email', attributes: { template_id: '' } },
    { type: 'email', attributes: {} },
  ])]);
  assert.deepEqual(ids, []);
});

// ---- the URL pin, which is the whole security argument -------------------

test('the body URL is rebuilt from sealed values, keeping only the signed token', () => {
  const url = bodyUrlFor({ locationId: LOCATION, templateId: TEMPLATE, previewUrl: previewUrl() });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, TEMPLATE_BODY_HOST);
  assert.equal(parsed.searchParams.get('token'), TOKEN);
  assert.equal(parsed.searchParams.get('alt'), 'media');
  assert.match(decodeURIComponent(parsed.pathname), new RegExp(`location/${LOCATION}/emails/${TEMPLATE}/index.html$`, 'u'));
});

test('a previewUrl pointing anywhere else is refused rather than followed', () => {
  const refused = [
    // Another host entirely.
    'https://evil.test/v0/b/highlevel-backend.appspot.com/o/x?alt=media&token=abcdefgh',
    // The right host, another ACCOUNT.
    previewUrl('someOtherLocation000', TEMPLATE),
    // The right host and account, another OBJECT.
    previewUrl(LOCATION, OTHER_TEMPLATE),
    // Plain http.
    previewUrl().replace('https://', 'http://'),
    // No token at all.
    previewUrl().replace(/&token=.*$/u, ''),
  ];
  for (const candidate of refused) {
    assert.equal(
      bodyUrlFor({ locationId: LOCATION, templateId: TEMPLATE, previewUrl: candidate }),
      null,
      candidate,
    );
  }
});

test('an extra query parameter the response added does not survive the rebuild', () => {
  const url = bodyUrlFor({
    locationId: LOCATION,
    templateId: TEMPLATE,
    previewUrl: `${previewUrl()}&download=1&redirect=https%3A%2F%2Fevil.test`,
  });
  const parsed = new URL(url);
  assert.deepEqual([...parsed.searchParams.keys()].sort(), ['alt', 'token']);
});

// ---- collection ----------------------------------------------------------

test('the copy is fetched and the signed URL never travels onward', async () => {
  const client = listClient([builder(TEMPLATE, 'Lead Seq B T2')]);
  const result = await collector(client).collectEmailCopy({
    workflows: [workflow([{ type: 'email', attributes: { template_id: TEMPLATE } }])],
  });

  assert.equal(result.complete, true);
  assert.equal(result.requestedCount, 1);
  assert.equal(result.templates.length, 1);
  assert.match(result.templates[0].body, /contact\.first_name/u);
  assert.equal(result.templates[0].name, 'Lead Seq B T2');
  // The signed URL is a credential for the object and it reaches the analysis briefs. It is dropped.
  assert.ok(!Object.hasOwn(result.templates[0], 'previewUrl'));
  // And so is the colleague's name, which no judgement about an email depends on.
  assert.ok(!Object.hasOwn(result.templates[0], 'updatedBy'));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('the list request carries the same policy block every governed read carries', async () => {
  const calls = [];
  const client = listClient([builder(TEMPLATE, 'T')], { calls });
  await collector(client).collectEmailCopy({
    workflows: [workflow([{ type: 'email', attributes: { template_id: TEMPLATE } }])],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.action, 'emails__fetch-template');
  assert.equal(calls[0].arguments.policy.allowlistHash, capability.allowlistHash);
  assert.equal(calls[0].arguments.policy.normalizedPath, '/emails/builder');
  assert.equal(calls[0].arguments.params.locationId, LOCATION);
});

test('no workflow email means no call at all', async () => {
  const calls = [];
  const client = listClient([builder(TEMPLATE, 'T')], { calls });
  const result = await collector(client).collectEmailCopy({
    workflows: [workflow([{ type: 'sms', attributes: { message: 'hi' } }])],
  });
  assert.equal(calls.length, 0, 'the library is not read when nothing points at it');
  assert.equal(result.complete, true);
  assert.deepEqual(result.templates, []);
});

test('a template the shared library does not hold is reported per template, not as a failure', async () => {
  // OBSERVED on a prior engagement: some send steps use a workflow-embedded builder template whose
  // id never appears in the library index.
  const client = listClient([builder(OTHER_TEMPLATE, 'Something else')]);
  const result = await collector(client).collectEmailCopy({
    workflows: [workflow([{ type: 'email', attributes: { template_id: TEMPLATE } }])],
  });

  assert.equal(result.complete, false);
  assert.ok(result.limitations.includes('EMAIL_TEMPLATE_NOT_IN_SHARED_LIBRARY'));
  assert.equal(result.templates[0].body, null);
  assert.equal(result.templates[0].bodyUnavailable, 'NOT_IN_SHARED_LIBRARY');
});

test('an unreadable body degrades to a stated reason and keeps every other template', async () => {
  const client = listClient([builder(TEMPLATE, 'A'), builder(OTHER_TEMPLATE, 'B')]);
  const result = await collector(client, {
    fetchBody: async (url) => {
      if (url.includes(TEMPLATE)) throw Object.assign(new Error('x'), { code: 'EMAIL_TEMPLATE_BODY_STATUS' });
      return '<p>readable</p>';
    },
  }).collectEmailCopy({
    workflows: [workflow([
      { type: 'email', attributes: { template_id: TEMPLATE } },
      { type: 'email', attributes: { template_id: OTHER_TEMPLATE } },
    ])],
  });

  const failed = result.templates.find(({ templateId }) => templateId === TEMPLATE);
  const ok = result.templates.find(({ templateId }) => templateId === OTHER_TEMPLATE);
  assert.equal(failed.bodyUnavailable, 'EMAIL_TEMPLATE_BODY_STATUS');
  assert.equal(failed.body, null);
  assert.match(ok.body, /readable/u);
  assert.ok(result.limitations.includes('EMAIL_TEMPLATE_BODY_UNREADABLE'));
});

test('a failure message that could carry the signed URL is reduced to a machine code', async () => {
  const client = listClient([builder(TEMPLATE, 'A')]);
  const result = await collector(client, {
    // A thrown error whose MESSAGE embeds the signed URL, which is what a real fetch failure does.
    fetchBody: async (url) => { throw new Error(`getaddrinfo failed for ${url}`); },
  }).collectEmailCopy({
    workflows: [workflow([{ type: 'email', attributes: { template_id: TEMPLATE } }])],
  });

  assert.equal(result.templates[0].bodyUnavailable, 'EMAIL_TEMPLATE_COLLECTION_FAILED');
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('a list hop that fails keeps the run and states that the copy is missing', async () => {
  const client = {
    callTool: async () => { throw Object.assign(new Error('x'), { code: 'TRANSPORT_FAILED' }); },
  };
  const result = await collector(client).collectEmailCopy({
    workflows: [workflow([{ type: 'email', attributes: { template_id: TEMPLATE } }])],
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.templates, []);
  assert.ok(result.limitations.includes('TRANSPORT_FAILED'));
  // The requested count survives, so the brief can say how much copy is missing.
  assert.equal(result.requestedCount, 1);
});

test('a list response of the wrong shape is refused rather than read as an empty library', async () => {
  const result = await collector({ callTool: async () => ({ structuredContent: { items: [] } }) })
    .collectEmailCopy({
      workflows: [workflow([{ type: 'email', attributes: { template_id: TEMPLATE } }])],
    });
  assert.equal(result.complete, false);
  assert.ok(result.limitations.includes('EMAIL_TEMPLATE_LIST_SHAPE'));
});

test('the body budget caps how many templates one run will fetch, and says it did', async () => {
  const client = listClient([builder(TEMPLATE, 'A'), builder(OTHER_TEMPLATE, 'B')]);
  const result = await collector(client, { budgets: { maxBodies: 1 } }).collectEmailCopy({
    workflows: [workflow([
      { type: 'email', attributes: { template_id: TEMPLATE } },
      { type: 'email', attributes: { template_id: OTHER_TEMPLATE } },
    ])],
  });

  assert.ok(result.limitations.includes('EMAIL_TEMPLATE_BODY_BUDGET_EXHAUSTED'));
  assert.equal(result.templates.filter(({ body }) => body !== null).length, 1);
});

test('the same evidence always produces the same bundle', async () => {
  const run = async () => collector(listClient([builder(TEMPLATE, 'A')])).collectEmailCopy({
    workflows: [workflow([{ type: 'email', attributes: { template_id: TEMPLATE } }])],
  });
  const [first, second] = [await run(), await run()];
  assert.equal(first.templatesHash, second.templatesHash);
});

test('a misconfigured collector refuses to exist rather than reading something else', () => {
  assert.throws(
    () => createEmailCopyCollector({ client: { callTool() {} }, capability: { ...capability, actionId: 'contacts.search' }, boundLocationId: LOCATION }),
    /EMAIL_COPY_CONFIG_INVALID/u,
  );
  assert.throws(
    () => createEmailCopyCollector({ client: {}, capability, boundLocationId: LOCATION }),
    /EMAIL_COPY_CONFIG_INVALID/u,
  );
});
