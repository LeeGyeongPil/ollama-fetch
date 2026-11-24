# 보안 정책 / Security policy

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

이 도구는 키나 토큰을 읽지 않고 익명으로만 내려받으며, 모든 블롭을 sha256 으로 확인합니다. 데모의 모의 레지스트리는 127.0.0.1 에서만 열립니다. / This tool reads no keys or tokens, downloads anonymously only, and verifies every blob by sha256. The demo's mock registry binds to 127.0.0.1 only.
