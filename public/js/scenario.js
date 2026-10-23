// Human-readable summary of which intentional bugs a server has active (from /api/mode).
export function describe(chaos) {
  const on = [];
  if (chaos.staircase) on.push('sequential partner calls');
  if (chaos.chat) on.push('chat missing await');
  return on.length ? `bugs on: ${on.join(' · ')}` : 'all intentional bugs fixed';
}
