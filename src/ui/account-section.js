import { h } from './dom.js';
import {
  accountState, account, aiQuota, signIn, signOut, deleteAccount, onAccountChange,
  SIGN_IN_PROVIDERS, FREE_TIER_DAILY, PRIVACY_URL,
} from '../account.js';

// Settings → Account: the sign-in buttons, or who's signed in with Sign out and
// Delete account. toast(text) tells the player how those went.
export function accountSection({ toast }) {
  const el = h('div.account-settings');
  const privacy = () => h('a.account-privacy', { href: PRIVACY_URL, target: '_blank', rel: 'noopener', text: 'Privacy and terms' });

  async function remove() {
    if (!confirm('Delete your account? Your name, email and sign-in are removed from our server for good. Constructions saved in this browser stay.')) return;
    try {
      await deleteAccount();
      toast('Account deleted');
    } catch (err) {
      toast(err.message);
    }
  }

  function render() {
    const { user, signedIn, checking, offline, error } = accountState();
    if (user) {
      el.replaceChildren(
        h('p.account-who', {}, 'Signed in as ', h('b', { text: user.name }), user.email ? ` (${user.email})` : ''),
        h('div.btn-row', {},
          h('button.btn.grow', { type: 'button', text: 'Sign out', on: { click: async () => { await signOut(); toast('Signed out'); } } }),
          h('button.btn.grow.danger', { type: 'button', text: 'Delete account', on: { click: remove } })),
        privacy());
    } else if (signedIn && checking) {
      el.replaceChildren(h('p.account-who', { text: 'Signing in…' }));
    } else if (offline) {
      el.replaceChildren(h('p.account-who', { text: 'Sign-in is unavailable right now.' }));
    } else {
      el.replaceChildren(
        h(`p.account-who${error ? '.failed' : ''}`, { text: error ?? `Sign in for ${FREE_TIER_DAILY} free AI generations a day.` }),
        h('div.btn-col', {}, SIGN_IN_PROVIDERS.map((p) => h('button.btn', {
          type: 'button', text: p.label, title: 'Leaves this page to sign in; the scene reloads after',
          on: { click: () => signIn(p.id) },
        }))),
        privacy());
    }
  }

  onAccountChange(render);
  render();
  // opening the drawer checks the session, and whether the relay answers at all
  const sync = () => { if (el.closest('.drawer.open')) { account(); aiQuota(); } };
  return { title: 'Account', rows: [{ type: 'custom', el, sync }] };
}
