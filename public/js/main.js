import { initSearch } from './search.js';
import { initBooking } from './booking.js';
import { initChat } from './chat.js';

initSearch();
initBooking();
initChat();

// Apply server-side feature flags
fetch('/api/config').then(r => r.json()).then(cfg => {
  if (!cfg.showLoadingTimer) document.querySelector('.timer-display').style.display = 'none';
}).catch(() => {});
