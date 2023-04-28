const core = require('@actions/core');
const github = require('@actions/github');

async function main() {
  const token = core.getInput('GITHUB_TOKEN');
  const issue = core.getInput('ISSUE');
  const message = core.getInput('MESSAGE');

  const octokit = github.getOctokit(token);

  await octokit.rest.issues.createComment({
    issue_number: issue,
    body: message,
    ...github.context.repo,
  });
}

main().catch((err) => core.setFailed(err.message));
