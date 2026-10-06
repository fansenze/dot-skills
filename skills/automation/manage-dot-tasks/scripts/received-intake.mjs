/** All-sender intake records message provenance; it creates no identity binding. */
import {ConnectorError} from './connectors/contract.mjs';

const triggerFields = ['account_id','brand','tenant_id','sender_tenant_id','sender_id','destination_id','chat_type','sender_type',
  'provider_app_id','provider_event_id','event_id','message_id','cursor','occurred_at','received_at'];
export const messageTrigger = e => Object.fromEntries(triggerFields.filter(key => e[key] !== undefined).map(key => [key, e[key]]));

// Resolve a reply/context view from this message, never persist another grant.
export const grantForMessage = (g, r) => g?.all_senders && r?.envelope ? {...g,
  tenant:r.envelope.tenant_id, sender:r.envelope.sender_id, destination:r.envelope.destination_id} : g;

export function grantMatches(g, e) {
  if (!g.enabled || g.account !== e.account_id) return false;
  const received = Date.parse(e.received_at), occurred = (e.occurred_at === undefined || (g.all_senders && e.occurred_at === null)) ? received : Date.parse(e.occurred_at), since = Date.parse(g.since);
  if (!Number.isFinite(received) || !Number.isFinite(occurred)) return false;
  if (g.all_senders) {
    // Provider time retains milliseconds; the receiver stores received_at in seconds.
    return occurred >= since && received >= Math.floor(since / 1000) * 1000;
  }
  return g.tenant === e.tenant_id && g.tenant === e.sender_tenant_id && g.sender === e.sender_id &&
    g.destination === e.destination_id && Math.min(received, occurred) >= since;
}

export function configureAllSenders(data, connection, policy, args) {
  if (args.mode !== 'agent' || ['tenant','sender','destination','context_from'].some(key => args[key] !== undefined)) {
    throw new ConnectorError('all-senders requires agent mode without fixed identity or context-from');
  }
  if (connection.settings.account_id && connection.settings.account_id !== policy.account) throw new ConnectorError('Intake account differs from connector');
  if (data.grants.some(g => g.all_senders && g.enabled && g.connector === connection.id && g.account === policy.account && g.id !== policy.id)) {
    throw new ConnectorError('Reuse the existing all-senders policy');
  }
  policy.all_senders = true;
}

export function validateAllSenders(data) {
  const seen = new Set();
  for (const p of data.grants.filter(g => g.all_senders)) {
    if (p.all_senders !== true || p.mode !== 'agent' || !Number.isFinite(Date.parse(p.since)) ||
      ['tenant','sender','destination','context_from'].some(key => p[key] !== undefined)) throw new ConnectorError('Invalid all-senders policy');
    const key = JSON.stringify([p.connector,p.account]);
    if (p.enabled && seen.has(key)) throw new ConnectorError('Conflicting all-senders policies');
    if (p.enabled) seen.add(key);
  }
}
