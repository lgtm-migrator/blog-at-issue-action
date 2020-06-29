import { resolve as pathResolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { exec } from '@actions/exec';
import Git, { SimpleGit } from 'simple-git';

import replaceStr from './utils/replace';
import isExist from './utils/is-exist';
import runPrettier from './linters/prettier';
import runTextLint from './linters/textlint';

(async () => {
  try {
    const { payload, issue } = github.context;
    const token = core.getInput('token', { required: true });
    const octokit = github.getOctokit(token);
    const repo = process.env.GITHUB_REPOSITORY;
    if (
      !payload.issue ||
      payload.issue.locked ||
      !['opened', 'edited', 'reopened', 'labeled'].includes(
        payload.action || ''
      )
    ) {
      core.info('exit: not issue / locked / action');
      return;
    }

    const body = payload.issue.body;
    if (!body) {
      core.info('exit: body is nothing');
      return;
    }
    const labels = core.getInput('labels') || ['blog'];
    if (
      !payload.issue.labels.some(({ name }: { name: string }) =>
        labels.includes(name)
      )
    ) {
      core.info('exit: has not label');
      return;
    }

    await Git()
      .silent(true)
      .clone(
        `https://${process.env.GITHUB_ACTOR}:${token}$@github.com/${repo}.git`
      );
    const directory = pathResolve(__dirname, repo ? repo.split('/')[1] : '');
    const fileName = replaceStr(core.getInput('filepath'), {
      title: payload.issue.title
    });
    const filepath = pathResolve(directory, fileName);
    const branch = `blog-at-issue/${fileName}`;

    const search = await octokit.search.issuesAndPullRequests({
      q: `repo:${repo} is:pr author:app/github-actions is:open ${fileName}`
    });
    const isExistPR = !!search.data.items[0]; // 現在進行中のPR

    const git: SimpleGit = Git(directory);

    if (!isExistPR) {
      // ブランチの残骸が残ってれば消す
      const branches = await git.branch();
      if (branches.all.includes(branch)) {
        await git.branch(['-D', branch]);
      }
      await octokit.git.deleteRef({
        owner: issue.owner,
        repo: issue.repo,
        ref: `heads/${branch}`
      });
    }

    await git.checkoutLocalBranch(branch);

    // textlintのルールがほしいので力技で入れる
    const packageJson = JSON.parse(
      readFileSync(`${directory}/package.json`, 'utf8')
    );
    const deps = [
      ...Object.keys(packageJson.dependencies).map(
        dep => `${dep}@${packageJson.dependencies[dep]}`
      ),
      ...Object.keys(packageJson.devDependencies).map(
        dep => `${dep}@${packageJson.devDependencies[dep]}`
      )
    ];
    await exec(`yarn global add ${deps.join(' ')}`);

    const isExistFile = isExist(filepath);
    writeFileSync(filepath, body);

    await runPrettier(filepath).then(() => runTextLint(filepath));
    await git.add(filepath);

    const status = await git.status();
    if (!status.modified[0] && !status.created[0]) {
      core.info('exit: has not any changes');
      return;
    }

    await git.commit(`${isExistFile ? 'Update' : 'Create'} ${fileName}`);
    await git.push('origin', branch);

    if (!isExistPR) {
      const pr = await octokit.pulls.create({
        owner: issue.owner,
        repo: issue.repo,
        title: `${isExistFile ? 'Update' : 'Create'} ${fileName} by Blog@Issue`,
        head: branch,
        base: payload.repository?.default_branch || 'master'
      });

      await octokit.issues.createComment({
        owner: issue.owner,
        repo: issue.repo,
        issue_number: issue.number,
        body: `Congrats!✨ A pull request: #${pr.data.number} has been created!`
      });
    }
  } catch (e) {
    core.setFailed(e.message);
  }
})();