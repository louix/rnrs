// Run from the repository root after npm ci, inside nix develop .#web with scripts/rust-env.sh sourced.
// --test runs the page in headless Chromium with driver.mjs dispatching real CDP pointer input.
import {existsSync, mkdirSync, realpathSync, symlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadPackage, plan, writeAtomic} from '../../tools/rnr-gen/cli.mjs';
import {buildBundle, lockFile} from '../../tools/rnr-gen/bundle.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('.', import.meta.url));
process.chdir(root);
for (const [name, dir] of [['@rnrs/surface','rnr-surface'], ['@rnrs/labs-touch-probe','fixtures/touch-probe']]) {
  const link = path.join(root,'node_modules',name), source = path.join(root,'packages',dir);
  mkdirSync(path.dirname(link),{recursive:true});
  if (!existsSync(link)) symlinkSync(source,link,'dir');
  else if (realpathSync(link)!==realpathSync(source)) throw new Error('Unexpected installed package at '+link);
}
for (const out of plan([loadPackage(path.join(root,'packages/fixtures/touch-probe'))])) {
  if (!out.committed && out.file.endsWith('/index.ts')) writeAtomic(out.file,out.content);
}
buildBundle(fixture,'web',{out:path.join(fixture,'rnr'),locked:existsSync(lockFile(fixture,'web')),
  offline:process.env.RNR_OFFLINE!=='0'});
const run=(cmd,args,env=process.env)=>{
  const result=spawnSync(cmd,args,{stdio:'inherit',env});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(cmd+' exited '+result.status);
};
run('esbuild',[path.join(fixture,'main.ts'),'--bundle','--format=esm','--target=es2022','--outfile='+path.join(fixture,'dist/main.js')]);
if(process.argv.includes('--test')) run('node',['scripts/web-test.mjs',path.join(fixture,'result.json')],
  {...process.env,RNR_WEB_ROOT:fixture,RNR_WEB_DRIVER:path.join(fixture,'driver.mjs')});
