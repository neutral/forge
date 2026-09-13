import { greet } from './greeting.mjs';

const names = process.argv.slice(2);
console.log(greet(names.length ? names.join(' ') : undefined));
