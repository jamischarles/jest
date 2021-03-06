/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {GlobalConfig} from 'types/Config';
import type {Context} from 'types/Context';
import type {WatchPlugin} from './types';

import ansiEscapes from 'ansi-escapes';
import chalk from 'chalk';
import getChangedFilesPromise from './get_changed_files_promise';
import {replacePathSepForRegex} from 'jest-regex-util';
import HasteMap from 'jest-haste-map';
import isValidPath from './lib/is_valid_path';
import {getFailedSnapshotTests, isInteractive} from 'jest-util';
import {print as preRunMessagePrint} from './pre_run_message';
import createContext from './lib/create_context';
import runJest from './run_jest';
import updateGlobalConfig from './lib/update_global_config';
import SearchSource from './search_source';
import SnapshotInteractiveMode from './snapshot_interactive_mode';
import TestWatcher from './test_watcher';
import Prompt from './lib/Prompt';
import TestPathPatternPrompt from './test_path_pattern_prompt';
import TestNamePatternPrompt from './test_name_pattern_prompt';
import FailedTestsCache from './failed_tests_cache';
import WatchPluginRegistry from './lib/watch_plugin_registry';
import {KEYS, CLEAR} from './constants';

let hasExitListener = false;

export default function watch(
  initialGlobalConfig: GlobalConfig,
  contexts: Array<Context>,
  outputStream: stream$Writable | tty$WriteStream,
  hasteMapInstances: Array<HasteMap>,
  stdin?: stream$Readable | tty$ReadStream = process.stdin,
): Promise<void> {
  // `globalConfig` will be constantly updated and reassigned as a result of
  // watch mode interactions.
  let globalConfig = initialGlobalConfig;

  globalConfig = updateGlobalConfig(globalConfig, {
    mode: globalConfig.watch ? 'watch' : 'watchAll',
    passWithNoTests: true,
  });

  const watchPlugins = new WatchPluginRegistry(globalConfig.rootDir);
  if (globalConfig.watchPlugins != null) {
    for (const pluginModulePath of globalConfig.watchPlugins) {
      watchPlugins.loadPluginPath(pluginModulePath);
    }
  }

  const failedTestsCache = new FailedTestsCache();
  const prompt = new Prompt();
  const testPathPatternPrompt = new TestPathPatternPrompt(outputStream, prompt);
  const testNamePatternPrompt = new TestNamePatternPrompt(outputStream, prompt);
  const snapshotInteractiveMode = new SnapshotInteractiveMode(outputStream);
  let failedSnapshotTestPaths = [];
  let searchSources = contexts.map(context => ({
    context,
    searchSource: new SearchSource(context),
  }));
  let hasSnapshotFailure = false;
  let isRunning = false;
  let testWatcher;
  let shouldDisplayWatchUsage = true;
  let isWatchUsageDisplayed = false;

  testPathPatternPrompt.updateSearchSources(searchSources);

  hasteMapInstances.forEach((hasteMapInstance, index) => {
    hasteMapInstance.on('change', ({eventsQueue, hasteFS, moduleMap}) => {
      const validPaths = eventsQueue.filter(({filePath}) => {
        return isValidPath(globalConfig, contexts[index].config, filePath);
      });

      if (validPaths.length) {
        const context = (contexts[index] = createContext(
          contexts[index].config,
          {
            hasteFS,
            moduleMap,
          },
        ));
        prompt.abort();
        searchSources = searchSources.slice();
        searchSources[index] = {
          context,
          searchSource: new SearchSource(context),
        };
        testPathPatternPrompt.updateSearchSources(searchSources);
        startRun(globalConfig);
      }
    });
  });

  if (!hasExitListener) {
    hasExitListener = true;
    process.on('exit', () => {
      if (prompt.isEntering()) {
        outputStream.write(ansiEscapes.cursorDown());
        outputStream.write(ansiEscapes.eraseDown);
      }
    });
  }

  const startRun = (globalConfig: GlobalConfig) => {
    if (isRunning) {
      return null;
    }

    testWatcher = new TestWatcher({isWatchMode: true});
    isInteractive && outputStream.write(CLEAR);
    preRunMessagePrint(outputStream);
    isRunning = true;
    const configs = contexts.map(context => context.config);
    const changedFilesPromise = getChangedFilesPromise(globalConfig, configs);
    return runJest({
      changedFilesPromise,
      contexts,
      failedTestsCache,
      globalConfig,
      onComplete: results => {
        isRunning = false;
        hasSnapshotFailure = !!results.snapshot.failure;
        failedSnapshotTestPaths = getFailedSnapshotTests(results);

        // Create a new testWatcher instance so that re-runs won't be blocked.
        // The old instance that was passed to Jest will still be interrupted
        // and prevent test runs from the previous run.
        testWatcher = new TestWatcher({isWatchMode: true});

        testNamePatternPrompt.updateCachedTestResults(results.testResults);

        // Do not show any Watch Usage related stuff when running in a
        // non-interactive environment
        if (isInteractive) {
          if (snapshotInteractiveMode.isActive()) {
            snapshotInteractiveMode.updateWithResults(results);
            return;
          }
          if (shouldDisplayWatchUsage) {
            outputStream.write(
              usage(globalConfig, watchPlugins, hasSnapshotFailure),
            );
            shouldDisplayWatchUsage = false; // hide Watch Usage after first run
            isWatchUsageDisplayed = true;
          } else {
            outputStream.write(showToggleUsagePrompt());
            shouldDisplayWatchUsage = false;
            isWatchUsageDisplayed = false;
          }
        } else {
          outputStream.write('\n');
        }
        failedTestsCache.setTestResults(results.testResults);
        testNamePatternPrompt.updateCachedTestResults(results.testResults);
      },
      outputStream,
      startRun,
      testWatcher,
    }).catch(error => console.error(chalk.red(error.stack)));
  };

  let activePlugin: ?WatchPlugin;
  const onKeypress = (key: string) => {
    if (key === KEYS.CONTROL_C || key === KEYS.CONTROL_D) {
      outputStream.write('\n');
      process.exit(0);
      return;
    }

    if (activePlugin != null) {
      // if a plugin is activate, Jest should let it handle keystrokes, so ignore
      // them here
      return;
    }

    if (prompt.isEntering()) {
      prompt.put(key);
      return;
    }

    if (snapshotInteractiveMode.isActive()) {
      snapshotInteractiveMode.put(key);
      return;
    }

    // Abort test run
    if (
      isRunning &&
      testWatcher &&
      [KEYS.Q, KEYS.ENTER, KEYS.A, KEYS.O, KEYS.P, KEYS.T, KEYS.F].indexOf(
        key,
      ) !== -1
    ) {
      testWatcher.setState({interrupted: true});
      return;
    }

    const matchingWatchPlugin = watchPlugins.getPluginByPressedKey(
      parseInt(key, 16),
    );
    if (matchingWatchPlugin != null) {
      // "activate" the plugin, which has jest ignore keystrokes so the plugin
      // can handle them
      activePlugin = matchingWatchPlugin;
      activePlugin.enter(
        globalConfig,
        // end callback -- returns control to jest to handle keystrokes
        () => (activePlugin = null),
      );
    }

    switch (key) {
      case KEYS.Q:
        outputStream.write('\n');
        process.exit(0);
        return;
      case KEYS.ENTER:
        startRun(globalConfig);
        break;
      case KEYS.U:
        globalConfig = updateGlobalConfig(globalConfig, {
          updateSnapshot: 'all',
        });
        startRun(globalConfig);
        globalConfig = updateGlobalConfig(globalConfig, {
          // updateSnapshot is not sticky after a run.
          updateSnapshot: 'none',
        });
        break;
      case KEYS.I:
        if (hasSnapshotFailure) {
          snapshotInteractiveMode.run(
            failedSnapshotTestPaths,
            (path: string, shouldUpdateSnapshot: boolean) => {
              globalConfig = updateGlobalConfig(globalConfig, {
                mode: 'watch',
                testNamePattern: '',
                testPathPattern: replacePathSepForRegex(path),
                updateSnapshot: shouldUpdateSnapshot ? 'all' : 'none',
              });
              startRun(globalConfig);
              globalConfig = updateGlobalConfig(globalConfig, {
                // updateSnapshot is not sticky after a run.
                updateSnapshot: 'none',
              });
            },
          );
        }
        break;
      case KEYS.A:
        globalConfig = updateGlobalConfig(globalConfig, {
          mode: 'watchAll',
          testNamePattern: '',
          testPathPattern: '',
        });
        startRun(globalConfig);
        break;
      case KEYS.C:
        globalConfig = updateGlobalConfig(globalConfig, {
          mode: 'watch',
          testNamePattern: '',
          testPathPattern: '',
        });
        startRun(globalConfig);
        break;
      case KEYS.F:
        globalConfig = updateGlobalConfig(globalConfig, {
          onlyFailures: !globalConfig.onlyFailures,
        });
        startRun(globalConfig);
        break;
      case KEYS.O:
        globalConfig = updateGlobalConfig(globalConfig, {
          mode: 'watch',
          testNamePattern: '',
          testPathPattern: '',
        });
        startRun(globalConfig);
        break;
      case KEYS.P:
        testPathPatternPrompt.run(
          testPathPattern => {
            globalConfig = updateGlobalConfig(globalConfig, {
              mode: 'watch',
              testNamePattern: '',
              testPathPattern: replacePathSepForRegex(testPathPattern),
            });

            startRun(globalConfig);
          },
          onCancelPatternPrompt,
          {header: activeFilters(globalConfig)},
        );
        break;
      case KEYS.T:
        testNamePatternPrompt.run(
          testNamePattern => {
            globalConfig = updateGlobalConfig(globalConfig, {
              mode: 'watch',
              testNamePattern,
              testPathPattern: globalConfig.testPathPattern,
            });

            startRun(globalConfig);
          },
          onCancelPatternPrompt,
          {header: activeFilters(globalConfig)},
        );
        break;
      case KEYS.QUESTION_MARK:
        break;
      case KEYS.W:
        if (!shouldDisplayWatchUsage && !isWatchUsageDisplayed) {
          outputStream.write(ansiEscapes.cursorUp());
          outputStream.write(ansiEscapes.eraseDown);
          outputStream.write(
            usage(globalConfig, watchPlugins, hasSnapshotFailure),
          );
          isWatchUsageDisplayed = true;
          shouldDisplayWatchUsage = false;
        }
        break;
    }
  };

  const onCancelPatternPrompt = () => {
    outputStream.write(ansiEscapes.cursorHide);
    outputStream.write(ansiEscapes.clearScreen);
    outputStream.write(usage(globalConfig, watchPlugins, hasSnapshotFailure));
    outputStream.write(ansiEscapes.cursorShow);
  };

  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('hex');
    stdin.on('data', onKeypress);
  }

  startRun(globalConfig);
  return Promise.resolve();
}

const activeFilters = (globalConfig: GlobalConfig, delimiter = '\n') => {
  const {testNamePattern, testPathPattern} = globalConfig;
  if (testNamePattern || testPathPattern) {
    const filters = [
      testPathPattern
        ? chalk.dim('filename ') + chalk.yellow('/' + testPathPattern + '/')
        : null,
      testNamePattern
        ? chalk.dim('test name ') + chalk.yellow('/' + testNamePattern + '/')
        : null,
    ]
      .filter(f => !!f)
      .join(', ');

    const messages = ['\n' + chalk.bold('Active Filters: ') + filters];

    return messages.filter(message => !!message).join(delimiter);
  }

  return '';
};

const usage = (
  globalConfig,
  watchPlugins: WatchPluginRegistry,
  snapshotFailure,
  delimiter = '\n',
) => {
  const messages = [
    activeFilters(globalConfig),

    globalConfig.testPathPattern || globalConfig.testNamePattern
      ? chalk.dim(' \u203A Press ') + 'c' + chalk.dim(' to clear filters.')
      : null,
    '\n' + chalk.bold('Watch Usage'),

    globalConfig.watch
      ? chalk.dim(' \u203A Press ') + 'a' + chalk.dim(' to run all tests.')
      : null,

    globalConfig.onlyFailures
      ? chalk.dim(' \u203A Press ') + 'f' + chalk.dim(' to run all tests.')
      : chalk.dim(' \u203A Press ') +
        'f' +
        chalk.dim(' to run only failed tests.'),

    (globalConfig.watchAll ||
      globalConfig.testPathPattern ||
      globalConfig.testNamePattern) &&
    !globalConfig.noSCM
      ? chalk.dim(' \u203A Press ') +
        'o' +
        chalk.dim(' to only run tests related to changed files.')
      : null,

    snapshotFailure
      ? chalk.dim(' \u203A Press ') +
        'u' +
        chalk.dim(' to update failing snapshots.')
      : null,

    snapshotFailure
      ? chalk.dim(' \u203A Press ') +
        'i' +
        chalk.dim(' to update failing snapshots interactively.')
      : null,

    chalk.dim(' \u203A Press ') +
      'p' +
      chalk.dim(' to filter by a filename regex pattern.'),

    chalk.dim(' \u203A Press ') +
      't' +
      chalk.dim(' to filter by a test name regex pattern.'),

    ...watchPlugins
      .getPluginsOrderedByKey()
      .map(
        plugin =>
          chalk.dim(' \u203A Press') +
          ' ' +
          String.fromCodePoint(plugin.key) +
          ' ' +
          chalk.dim(`to ${plugin.prompt}.`),
      ),

    chalk.dim(' \u203A Press ') + 'q' + chalk.dim(' to quit watch mode.'),

    chalk.dim(' \u203A Press ') +
      'Enter' +
      chalk.dim(' to trigger a test run.'),
  ];

  return messages.filter(message => !!message).join(delimiter) + '\n';
};

const showToggleUsagePrompt = () =>
  '\n' +
  chalk.bold('Watch Usage: ') +
  chalk.dim('Press ') +
  'w' +
  chalk.dim(' to show more.');
