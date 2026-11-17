const fs = require('fs');
let code = fs.readFileSync('reconstruction/app/ui/walker-model.js', 'utf8');

const helpers = `

(function (root) {
  'use strict';
  const model = typeof module !== 'undefined' && module.exports ? module.exports : root.PkaWalker;
  model.canStand = flags => Number.isInteger(flags) && flags >= 0 && flags <= 255
    && (flags & 1) !== 0 && (flags & 4) === 0 && (flags & 8) === 0;
  model.canRoute = flags => model.canStand(flags) && (flags & 2) === 0;
})(typeof window === 'undefined' ? globalThis : window);

(function (root) {
  'use strict';
  const model = typeof module !== 'undefined' && module.exports ? module.exports : root.PkaWalker;
  const nativePosition = model.currentPosition;
  model.currentPosition = session => {
    if (session?.source === 'rpm' && session.capabilities?.walkerKeyboard === true
        && session.online && !session.stale && session.ageMs >= 0 && session.ageMs <= 1000
        && model.validPosition(session.telemetry?.position)) return { ...session.telemetry.position };
    return nativePosition(session);
  };
})(typeof window === 'undefined' ? globalThis : window);
`;

if (!code.includes('model.canStand')) {
  fs.writeFileSync('reconstruction/app/ui/walker-model.js', code.trim() + helpers, 'utf8');
  console.log('Appended walker helpers.');
} else {
  console.log('Already present.');
}
