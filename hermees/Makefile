.PHONY: dev build check lint preview clean install

dev:
	astro dev

build:
	astro build

check:
	tsc --noEmit

lint:
	eslint .

preview:
	astro preview

clean:
	rm -rf dist/ .astro/

install:
	npm ci
