const paths = {
  chat: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-6 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M7 9h10M7 13h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  logs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 9 2 2-2 2m5 1h5"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  plug: '<path d="m7 11 6 6m-5-5-2 2a3 3 0 0 0 4 4l2-2m0-9 3-3m1 7 3-3m-9 1 3-3 5 5-3 3"/>',
  server:
    '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01m5-10h5m-5 10h5"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  ram: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 18v2m4-2v2m4-2v2m-8-9v3m4-3v3m4-3v3"/>',
  wave: '<path d="M2 13h4l2-6 4 12 3-15 3 9h4"/>',
  circle: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5m0 3h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  refresh:
    '<path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6m-5 5a8 8 0 0 0 14 4l3-3m0 6v-6h-6"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  monitor:
    '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M7 21h10m-5-4v4"/>',
  external:
    '<path d="M14 3h7v7m0-7-10 10m-1-8H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  folder:
    '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  box: '<path d="M3 7 12 2l9 5v10l-9 5-9-5V7Zm0 0 9 5 9-5m-9 5v10"/>',
  code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5m-4-13-2 16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  filter:
    '<path d="M3 7h6m4 0h8M3 17h10m4 0h4"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  shield:
    '<path d="m12 2 8 4v6c0 5-4 8-8 10-4-2-8-5-8-10V6l8-4Z"/><path d="m8 12 3 3 5-6"/>',
  hash: '<path d="m10 3-4 18m12-18-4 18M4 9h17M3 15h17"/>',
  disk: '<path d="m5 4-3 11v4a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-4L19 4H5Zm-3 11h20m-5 2h1"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4"/>',
  signal: '<path d="M4 18v2m5-6v6m5-11v11m5-16v16"/>',
  graph: '<path d="M3 4v16h18M6 15l4-5 4 2 6-7"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 13 8-13 8V4Z"/>',
  moon: '<circle cx="12" cy="12" r="7"/><path d="M12 5v14"/>',
  link: '<path d="m10 14 4-4m-5-1 3-3a4 4 0 0 1 6 6l-2 2m-1 1-3 3a4 4 0 0 1-6-6l2-2"/>',
};
export const icon = (name, size = 18) =>
  '<svg aria-hidden="true" width="' +
  size +
  '" height="' +
  size +
  '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' +
  (paths[name] || paths.activity) +
  "</svg>";
