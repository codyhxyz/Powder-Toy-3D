// Halo's four modes use armor; Siege and sandbox keep the chosen body.
export function characterForMode(mode, choice = 'real') {
  return ['slayer', 'ctf', 'koth', 'infection'].includes(mode)
    ? 'spartan' : ['real', 'woman', 'stick'].includes(choice) ? choice : 'real';
}
