import {
  createReleaseChangelogWriterOpts,
  RELEASE_CHANGELOG_PARSER_OPTS,
  RELEASE_CHANGELOG_TYPES,
} from "./scripts/release-it/changelog-writer.mjs";

export default {
  git: {
    commitMessage: "chore: release v${version}",
    tagName: "v${version}",
    tagAnnotation: "Release v${version}",
    // release-it 用 `git push --follow-tags` 推送，而 --follow-tags 会把**所有从被推提交可达的
    // 附注 tag** 一起推上去。本地残留的历史 tag 因此会被顺带推送，而发版工作流是「推 tag 即公开发布」，
    // 结果是凭空发布一个旧版本。下面的 before:init 守卫会在发版前拦下这类 tag。
    push: true,
  },
  hooks: {
    "before:init": "node scripts/release-it/assert-no-local-only-tags.mjs",
  },
  github: {
    release: false,
  },
  gitlab: {
    release: false,
  },
  npm: {
    publish: false,
  },
  plugins: {
    "@release-it/conventional-changelog": {
      preset: {
        name: "conventionalcommits",
        types: RELEASE_CHANGELOG_TYPES,
      },
      parserOpts: RELEASE_CHANGELOG_PARSER_OPTS,
      writerOpts: createReleaseChangelogWriterOpts(),
      infile: "CHANGELOG.md",
    },
  },
};
