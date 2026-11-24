// 한국어 화면 문구. 키 집합은 en.ts 와 같아야 한다(타입으로 강제하고 test/i18n.test.ts 로 다시 확인).
import type { MessageKey } from './en.js';

export const ko: Record<MessageKey, string> = {
  help: `ollama-fetch {version} - 속도 제한·이어받기를 지원하는 Ollama 모델 다운로더 겸 분할 GGUF 병합기

사용법:
  ollama-fetch pull <모델> [옵션]
  ollama-fetch merge <첫-샤드.gguf> [-o <출력.gguf>] [--register <이름[:태그]>] [옵션]
  ollama-fetch demo [--keep]
  ollama-fetch --help | --version

pull 옵션:
  --limit-rate <N[K|M|G]>  모든 연결을 합친 속도 상한, 예: 500K, 3M (curl 과 같은 1024 기반)
  --connections <n>        동시에 받는 블롭 수 (기본 2, 최대 16)
  --dry-run                레이어·크기·있음/없음·예상 시간만 보여 주고 아무것도 쓰지 않음
  --retries <n>            끊김·다이제스트 불일치 때 블롭마다 재시도 횟수 (기본 6, 1초·2초·4초 … 대기)
  --registry <url>         레지스트리 주소(미러·테스트 서버). 저장 경로의 호스트 이름은 그대로
  -q, --quiet              오류와 마지막 줄만 출력

merge 옵션:
  -o, --output <파일>      병합한 GGUF 를 이 파일로 저장
  --register <이름[:태그]> 모델 폴더에 Ollama 모델로 등록 (Ollama 재시작 불필요)

demo 옵션:
  --keep                   임시 폴더를 지우지 않고 남겨 둠

공통 옵션:
  --models-dir <폴더>      Ollama 모델 폴더 (기본: $OLLAMA_MODELS, 없으면 ~/.ollama/models)
  --lang <en|ko>           화면 언어 (기본: $OLLAMA_FETCH_LANG → LC_ALL / LC_MESSAGES / LANG)

모델 이름 예: llama3.2:1b, library/qwen3:8b, registry.ollama.ai/library/smollm:135m
종료 코드: 0 성공, 1 사용법 오류, 2 입력 오류, 3 다이제스트 불일치, 4 네트워크 실패, 130 중단됨(다시 실행하면 이어받기)`,

  error_line: '오류: {message}',
  hint_help: "사용법은 'ollama-fetch --help' 로 볼 수 있습니다.",
  interrupted: '중단했습니다. 받던 파일은 남겨 두었으니 같은 명령을 다시 실행하면 이어서 받습니다.',
  proxy_hint:
    '참고: HTTPS_PROXY 가 설정돼 있지만 Node.js fetch 는 NODE_USE_ENV_PROXY=1 도 함께 있어야 프록시를 씁니다(Node 24+).',

  err_unknown_command: "알 수 없는 명령 '{command}' (pull, merge, demo 중 하나)",
  err_unknown_option: '알 수 없는 옵션 {option}',
  err_option_value: '옵션 {option} 에 값이 필요합니다',
  err_bad_option: '인자가 잘못됐습니다: {detail}',
  err_option_not_for: "옵션 {option} 은 '{command}' 명령에 쓸 수 없습니다",
  err_pull_needs_ref: 'pull 에는 모델 이름이 필요합니다. 예: ollama-fetch pull llama3.2:1b',
  err_merge_needs_shard: 'merge 에는 첫 샤드가 필요합니다. 예: ollama-fetch merge ./model-00001-of-00003.gguf',
  err_merge_needs_output: '분할 파일 이름이 아닙니다. -o <출력.gguf> 또는 --register <이름> 을 주세요',
  err_merge_output_is_input: '출력 {path} 가 입력 샤드 중 하나입니다',
  err_bad_rate: "--limit-rate 값 '{value}' 이 잘못됐습니다 (예: 500K, 3M, 1G)",
  err_bad_int: "{option} 값 '{value}' 이 잘못됐습니다 ({min}~{max} 사이 정수)",
  err_bad_lang: "--lang 값 '{value}' 이 잘못됐습니다 (en 또는 ko)",
  err_bad_registry: "--registry 값 '{value}' 이 잘못됐습니다 (http:// 또는 https:// 주소)",
  err_bad_ref: "모델 이름 '{ref}' 이 잘못됐습니다 (name, name:tag, namespace/name:tag, host/namespace/name:tag)",
  err_bad_digest: "다이제스트 '{digest}' 이 잘못됐습니다 (sha256:<16진수 64자> 형식)",
  err_bad_manifest: '레지스트리가 {ref} 의 매니페스트를 잘못된 형식으로 줬습니다',
  err_manifest_404: '레지스트리에 모델이 없습니다: {ref}',
  err_network: '{url} 에 연결할 수 없습니다: {reason}',
  err_http: '{url} 에서 HTTP {status} 응답',
  err_too_many_redirects: '{url} 의 리다이렉트가 너무 많습니다',
  err_retries_exhausted: '재시도를 모두 썼지만 {digest} 를 받지 못했습니다: {reason}',
  err_digest_mismatch: '재시도 후에도 {digest} 의 다이제스트가 맞지 않습니다(받은 값 {actual}). 아무것도 저장하지 않았습니다',
  err_not_writable: '{path} 에 쓸 수 없습니다 (권한을 확인하거나 --models-dir 를 쓰세요)',
  err_file_missing: '파일이 없습니다: {path}',
  err_not_gguf: 'GGUF 파일이 아닙니다: {path}',
  err_gguf_truncated: 'GGUF 가 깨졌거나 잘렸습니다: {path} ({pos} 바이트 지점)',
  err_gguf_version: '지원하지 않는 GGUF 버전 {version}: {path} (지원: 2, 3)',
  err_gguf_bad_type: '{path} 에 알 수 없는 GGUF 값 타입 {type}',
  err_gguf_alignment: '{path} 의 general.alignment 값 {alignment} 이 잘못됐습니다',
  err_shards_missing: '전체 {count}개 중 빠진 샤드: {missing}',
  err_split_count: '{file} 의 split.count 가 맞지 않습니다: 기대 {expected}, 실제 {actual}',
  err_split_no: '{file} 의 split.no 가 맞지 않습니다: 기대 {expected}, 실제 {actual}',
  err_split_tensors: 'split.tensors.count 는 텐서 {expected}개라고 하지만 샤드에는 {actual}개가 있습니다',
  err_duplicate_tensor: '텐서 {name} 이 여러 샤드에 있습니다',
  err_unexpected: '예상하지 못한 오류: {message}',

  rate_unlimited: '제한 없음',
  pull_start: '{registry} 에서 {ref} 받는 중',
  pull_settings: '속도 상한 {rate}(모든 연결 합계), 연결 {connections}개, 모델 폴더 {modelsDir}',
  pull_manifest: '매니페스트: 블롭 {layers}개, {total}',
  blob_skip: '  건너뜀      {digest}  {size}  이미 있음(sha256 확인)',
  blob_start: '  받기        {digest}  {size}  {media}',
  blob_drop: '  {digest} 의 {pct}% ({at} 바이트) 지점에서 연결이 끊김: {reason}. {delay} 뒤 재시도 {failure}/{retries}',
  blob_resume: '  {digest} 를 {at} 바이트({pct}%)부터 이어받기 (HTTP 206 Range)',
  blob_range_ignored: '  서버가 {digest} 의 Range 를 무시함(HTTP {status}). 받아 둔 {had} 바이트를 버리고 처음부터 받음',
  blob_verify_fail: '  {digest} 의 sha256 불일치(받은 값 {actual}). 버리고 재시도 {failure}/{retries}',
  blob_done: '  sha256 확인 {digest}  {size}, {time} ({rate})',
  manifest_written: '  매니페스트  {path}',
  pull_done: '완료: {ref} - 블롭 {count}개, {bytes} 를 {time} 동안 받음({rate}). 이제 `ollama list` 에 보입니다.',
  pull_nothing: '완료: {ref} 는 이미 다 받아져 있어 블롭을 받지 않았습니다.',
  progress_line: '{done} / {total} ({pct}%)  {rate}  남은 시간 {eta}',

  plan_title: '모델        {ref}\n레지스트리  {registry}\n모델 폴더   {modelsDir}\n',
  plan_col_media: '미디어 타입',
  plan_col_size: '크기',
  plan_col_status: '상태',
  plan_col_digest: '다이제스트',
  plan_present: '있음',
  plan_missing: '없음',
  plan_total: '합계 {total}, 블롭 {blobs}개. 받을 양 {toGet} (없는 블롭 {missing}개)',
  plan_eta: '{rate} 기준 예상 시간: {eta}',
  plan_eta_unlimited: '예상 시간: 회선 속도에 따라 다름(--limit-rate 없음)',
  plan_no_files: '미리 보기라 아무것도 쓰지 않았습니다.',

  merge_found: '샤드 {count}개 찾음: {files}',
  merge_checked: 'split 키 확인: 텐서 {tensors}개, 메타데이터 키 {kv}개. 제거할 키 {removed}',
  merge_done: '샤드 {count}개를 {out} ({size}) 로 병합, {time}',
  merge_done_single: '{out} ({size}) 를 다시 씀, {time}',
  merge_sha: '  sha256 {sha} (쓰면서 계산)',
  register_done: '{name} 로 등록: {path}',
  register_hint: '실행해 보기: ollama run {name}   (Ollama 재시작 불필요)',

  demo_title:
    'ollama-fetch 데모 - 127.0.0.1 의 연습용 모의(mock) 레지스트리와 합성 소형 GGUF 파일로 실행합니다. 실제 모델이 아닙니다.',
  demo_step_pull: '[1/4] 속도 제한 받기({rate}, 연결 {connections}개). 모의 레지스트리가 모델 블롭 40% 지점에서 연결을 끊습니다.',
  demo_step_rerun: '[2/4] 같은 명령을 한 번 더: 이미 다 있으니 받을 것이 없습니다.',
  demo_rerun_result: '  두 번째 실행의 블롭 요청 수: {requests}',
  demo_step_merge: '[3/4] 분할 GGUF 샤드 3개를 병합해 {name} 로 등록합니다.',
  demo_step_tree: '[4/4] Ollama 가 보는 {dir} 구조:',
  demo_kept: '파일을 {dir} 에 남겨 두었습니다',
  demo_footer:
    '지금까지는 가짜 소형 모델을 쓴 연습용 모의 레지스트리였습니다. 실제 모델은: ollama-fetch pull llama3.2:1b --limit-rate 3M',
};
