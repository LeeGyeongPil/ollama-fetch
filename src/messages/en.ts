// English UI messages. Every key here must also exist in ko.ts (checked by the compiler and test/i18n.test.ts).
export const en = {
  help: `ollama-fetch {version} - rate-limited, resumable Ollama model downloader and split-GGUF merger

Usage:
  ollama-fetch pull <model> [options]
  ollama-fetch merge <first-shard.gguf> [-o <out.gguf>] [--register <name[:tag]>] [options]
  ollama-fetch demo [--keep]
  ollama-fetch --help | --version

pull options:
  --limit-rate <N[K|M|G]>  total speed cap shared by all connections, e.g. 500K, 3M (1024-based, like curl)
  --connections <n>        blobs downloaded at the same time (default 2, max 16)
  --dry-run                show layers, sizes, present/missing and ETA; write nothing
  --retries <n>            retries per blob after a drop or a bad digest (default 6; waits 1s, 2s, 4s ...)
  --registry <url>         registry base URL (mirror or test server); the stored host name stays the same
  -q, --quiet              print only errors and the final line

merge options:
  -o, --output <file>      write the merged GGUF to this file
  --register <name[:tag]>  store it in the models dir as an Ollama model (no restart needed)

demo options:
  --keep                   keep the temporary folder so you can look at the files

common options:
  --models-dir <dir>       Ollama models dir (default: $OLLAMA_MODELS, else ~/.ollama/models)
  --lang <en|ko>           UI language (default: $OLLAMA_FETCH_LANG, then LC_ALL / LC_MESSAGES / LANG)

Model names: llama3.2:1b, library/qwen3:8b, registry.ollama.ai/library/smollm:135m
Exit codes: 0 ok, 1 usage error, 2 bad input, 3 digest mismatch, 4 network failure`,

  error_line: 'error: {message}',
  hint_help: "Run 'ollama-fetch --help' for usage.",
  interrupted: 'Interrupted. Partial downloads are kept; run the same command again to resume.',
  proxy_hint:
    'note: HTTPS_PROXY is set but Node.js fetch ignores it unless NODE_USE_ENV_PROXY=1 is also set (Node 24+).',

  err_unknown_command: "unknown command '{command}' (use pull, merge or demo)",
  err_unknown_option: 'unknown option {option}',
  err_option_value: 'option {option} needs a value',
  err_bad_option: 'invalid arguments: {detail}',
  err_option_not_for: "option {option} does not apply to '{command}'",
  err_pull_needs_ref: 'pull needs a model name, e.g. ollama-fetch pull llama3.2:1b',
  err_merge_needs_shard: 'merge needs the first shard, e.g. ollama-fetch merge ./model-00001-of-00003.gguf',
  err_merge_needs_output: 'this is not a split file name; give -o <out.gguf> or --register <name>',
  err_merge_output_is_input: 'output {path} is one of the input shards',
  err_bad_rate: "invalid --limit-rate '{value}' (use e.g. 500K, 3M, 1G)",
  err_bad_int: 'invalid {option} \'{value}\' (whole number from {min} to {max})',
  err_bad_lang: "invalid --lang '{value}' (use en or ko)",
  err_bad_registry: "invalid --registry '{value}' (use an http:// or https:// URL)",
  err_bad_ref: "invalid model name '{ref}' (use name, name:tag, namespace/name:tag or host/namespace/name:tag)",
  err_bad_digest: "invalid digest '{digest}' (expected sha256:<64 hex>)",
  err_bad_manifest: 'the registry returned an invalid manifest for {ref}',
  err_manifest_404: 'model not found in the registry: {ref}',
  err_network: 'cannot reach {url}: {reason}',
  err_http: 'HTTP {status} from {url}',
  err_too_many_redirects: 'too many redirects for {url}',
  err_retries_exhausted: 'gave up on {digest} after all retries: {reason}',
  err_digest_mismatch: 'digest mismatch for {digest} after all retries (got {actual}); nothing was saved',
  err_not_writable: 'cannot write to {path} (check permissions or use --models-dir)',
  err_file_missing: 'file not found: {path}',
  err_not_gguf: 'not a GGUF file: {path}',
  err_gguf_truncated: 'broken or truncated GGUF: {path} (at byte {pos})',
  err_gguf_version: 'unsupported GGUF version {version}: {path} (supported: 2, 3)',
  err_gguf_bad_type: 'unknown GGUF value type {type} in {path}',
  err_gguf_alignment: 'invalid general.alignment {alignment} in {path}',
  err_shards_missing: 'missing shard(s) of {count}: {missing}',
  err_split_count: 'split.count mismatch in {file}: expected {expected}, found {actual}',
  err_split_no: 'split.no mismatch in {file}: expected {expected}, found {actual}',
  err_split_tensors: 'split.tensors.count says {expected} tensors but the shards hold {actual}',
  err_duplicate_tensor: 'tensor {name} appears in more than one shard',
  err_unexpected: 'unexpected error: {message}',

  rate_unlimited: 'no limit',
  pull_start: 'Pulling {ref} from {registry}',
  pull_settings: 'speed cap {rate} (all connections together), {connections} connection(s), models dir {modelsDir}',
  pull_manifest: 'manifest: {layers} blobs, {total}',
  blob_skip: '  skip        {digest}  {size}  already present (sha256 verified)',
  blob_start: '  get         {digest}  {size}  {media}',
  blob_drop: '  connection lost at {pct}% ({at} bytes) of {digest}: {reason}; retry {failure}/{retries} in {delay}',
  blob_resume: '  resumed at {at} bytes ({pct}%) of {digest} with HTTP 206 Range',
  blob_range_ignored: '  server ignored Range (HTTP {status}) for {digest}; discarding {had} bytes and starting over',
  blob_verify_fail: '  sha256 mismatch for {digest} (got {actual}); discarded, retry {failure}/{retries}',
  blob_done: '  sha256 OK   {digest}  {size} in {time} ({rate})',
  manifest_written: '  manifest    {path}',
  pull_done: 'Done: {ref} - downloaded {count} blob(s), {bytes} in {time} ({rate}). It shows up in `ollama list` now.',
  pull_nothing: 'Done: {ref} was already complete - no blob downloads needed.',
  progress_line: '{done} / {total} ({pct}%)  {rate}  ETA {eta}',

  plan_title: 'Model       {ref}\nRegistry    {registry}\nModels dir  {modelsDir}\n',
  plan_col_media: 'MEDIA TYPE',
  plan_col_size: 'SIZE',
  plan_col_status: 'STATUS',
  plan_col_digest: 'DIGEST',
  plan_present: 'present',
  plan_missing: 'missing',
  plan_total: 'Total {total} in {blobs} blobs; to download {toGet} ({missing} missing)',
  plan_eta: 'Estimated time at {rate}: {eta}',
  plan_eta_unlimited: 'Estimated time: depends on your connection (no --limit-rate given)',
  plan_no_files: 'Dry run: nothing was written.',

  merge_found: 'Found {count} shard(s): {files}',
  merge_checked: 'split keys OK: {tensors} tensors, {kv} metadata keys; removing {removed}',
  merge_done: 'merged {count} shards into {out} ({size}) in {time}',
  merge_done_single: 'rewrote {out} ({size}) in {time}',
  merge_sha: '  sha256 {sha} (computed while writing)',
  register_done: 'Registered {name}: {path}',
  register_hint: 'Try it: ollama run {name}   (no Ollama restart needed)',

  demo_title:
    'ollama-fetch demo - this runs against a local practice mock registry on 127.0.0.1 with synthetic tiny GGUF files, not real models.',
  demo_step_pull: '[1/4] Rate-limited pull ({rate}, {connections} connections). The mock registry will cut the model download at 40%.',
  demo_step_rerun: '[2/4] Same command again: everything is already there.',
  demo_rerun_result: '  blob requests on the second run: {requests}',
  demo_step_merge: '[3/4] Merge 3 split GGUF shards and register them as {name}.',
  demo_step_tree: '[4/4] What Ollama sees in {dir}:',
  demo_kept: 'Files kept in {dir}',
  demo_footer:
    'That was a practice mock registry with fake tiny models. For a real model run: ollama-fetch pull llama3.2:1b --limit-rate 3M',
};

export type MessageKey = keyof typeof en;
