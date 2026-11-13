.PHONY: setup dev build test install verify lint-doc-radar
setup:
	pnpm install --frozen-lockfile
dev:
	pnpm run dev .
build:
	pnpm run build
test:
	pnpm test
install:
	pnpm run install:app
verify:
	pnpm run verify
lint-doc-radar:
	pnpm run test:docs
