declare var define: any;
declare var node: any;
declare var appshell: any;

define(function (require, exports, module) {
    "use strict";

    var FileUtils           = require("file/FileUtils"),
        FileSystemStats     = require("filesystem/FileSystemStats"),
        FileSystemError     = require("filesystem/FileSystemError");

    /**
     * @const
     */
    var FILE_WATCHER_BATCH_TIMEOUT = 200;   // 200ms - granularity of file watcher changes

    /**
     * Callback to notify FileSystem of watcher changes
     * @type {?function(string, FileSystemStats=)}
     */
    var _changeCallback;

    /**
     * Callback to notify FileSystem if watchers stop working entirely
     * @type {?function()}
     */
    var _offlineCallback;

    /** Timeout used to batch up file watcher changes (setTimeout() return value) */
    var _changeTimeout;

    /**
     * Pending file watcher changes - map from fullPath to flag indicating whether we need to pass stats
     * to _changeCallback() for this path.
     * @type {!Object.<string, boolean>}
     */
    var _pendingChanges = {};

    /**
     * Enqueue a file change event for eventual reporting back to the FileSystem.
     *
     * @param {string} changedPath The path that was changed
     * @param {boolean} needsStats Whether or not the eventual change event should include stats
     * @private
     */
    function _enqueueChange(changedPath, needsStats) {
        _pendingChanges[changedPath] = _pendingChanges[changedPath] || needsStats;

        if (!_changeTimeout) {
            _changeTimeout = window.setTimeout(function () {
                if (_changeCallback) {
                    Object.keys(_pendingChanges).forEach(function (path) {
                        var needsStats = _pendingChanges[path];
                        if (needsStats) {
                            exports.stat(path, function (err, stats) {
                                if (err) {
                                    // warning has been removed due to spamming the console - see #7332
                                    // console.warn("Unable to stat changed path: ", path, err);
                                    return;
                                }
                                _changeCallback(path, stats);
                            });
                        } else {
                            _changeCallback(path);
                        }
                    });
                }

                _changeTimeout = null;
                _pendingChanges = {};
            }, FILE_WATCHER_BATCH_TIMEOUT);
        }
    }

    /**
     * Event handler for the Node fileWatcher domain's change event.
     *
     * @param {jQuery.Event} The underlying change event
     * @param {string} event The type of the event: either "change" or "rename"
     * @param {string} path The path that is reported to have changed
     * @param {string=} filename The name of the file that changed.
     * @private
     */
    function _fileWatcherChange(event, path, filename) {
        if (event === "changed") {
            // only register change events if filename is passed
            if (filename) {
                // an existing file was modified; submit change for the file itself
                _enqueueChange(path + filename, true);
            }
        } else if (event === "renamed" || event === "created" || event === "removed") {
            // a new file was created; submit change for parent folder
            _enqueueChange(path, false);
        } else {
            console.warn("_fileWatcherChange: unhandled event: " + event);
        }
    }

    var _bracketsPath   = FileUtils.getNativeBracketsDirectoryPath();
    var _modulePath     = FileUtils.getNativeModuleDirectoryPath(module);
    var workerPath = [_bracketsPath, _modulePath, "node/FileWatcherWorker.js"].join("/");
    var worker = node.require("child_process").fork(workerPath);
    var workerCounter = 0;
    var workerCallbacks = {};
    var workerSend = function (msg, data, callback) {
        if (callback) {
            var id = workerCounter++;
            workerCallbacks[id] = callback;
            msg = msg + "!" + id;
        }
        worker.send({msg: msg, data: data});
    };

    // If the connection closes, notify the FileSystem that watchers have gone offline.
    worker.on("disconnect", function () {
	   if (_offlineCallback) { _offlineCallback(); }
	});
    // Setup the message handler. This only needs to happen once.
    worker.on("message", function (obj) {
        var callbackId;
        var msg = obj.msg;
        var data = obj.data;

        if (msg.indexOf("!") !== -1) {
            var spl = msg.split("!");
            msg = spl[0];
            callbackId = parseInt(spl[1], 10);
        }

        if (msg === "log") {
            console.log(data);
        } else if (msg === "callback") {
            workerCallbacks[callbackId].apply(null, data);
            workerCallbacks[callbackId] = null;
        } else if (msg === "change") {
            _fileWatcherChange.apply(null, data);
        } else {
            console.error("AppshellFileSystem got unsupported message: " + msg);
        }
    });

    /**
     * Convert appshell error codes to FileSystemError values.
     *
     * @param {?number} err An appshell error code
     * @return {?string} A FileSystemError string, or null if there was no error code.
     * @private
     */
    function _mapError(err) {
        if (!err) {
            return null;
        }

        switch (err.code) {
            case "EEXIST":
                return FileSystemError.ALREADY_EXISTS;
            case "ENOENT":
            case "ENOTDIR":
                return FileSystemError.NOT_FOUND;
            case "ENOSPC":
                return FileSystemError.OUT_OF_SPACE;
            case "ECHARSET":
                return FileSystemError.UNSUPPORTED_ENCODING;
            case "EISDIR":
            case "EPERM":
            case "EACCES":
            case "EROFS":
                return FileSystemError.PERM_DENIED;
        }

        console.warn("got error from fs, but no FileSystemError mapping was found: " + err);

        // do not actually return FileSystemError.UNKNOWN
        // it has no point hiding what the actual error is
        return err;
    }

    /**
     * Convert a callback to one that transforms its first parameter from an
     * appshell error code to a FileSystemError string.
     *
     * @param {function(?number)} cb A callback that expects an appshell error code
     * @return {function(?string)} A callback that expects a FileSystemError string
     * @private
     */
    function _wrap(cb) {
        return function (err) {
            var args = Array.prototype.slice.call(arguments);
            args[0] = _mapError(args[0]);
            cb.apply(null, args);
        };
    }

    /**
     * Display an open-files dialog to the user and call back asynchronously with
     * either a FileSystmError string or an array of path strings, which indicate
     * the entry or entries selected.
     *
     * @param {boolean} allowMultipleSelection
     * @param {boolean} chooseDirectories
     * @param {string} title
     * @param {string} initialPath
     * @param {Array.<string>=} fileTypes
     * @param {function(?string, Array.<string>=)} callback
     */
    function showOpenDialog(allowMultipleSelection, chooseDirectories, title, initialPath, fileTypes, callback) {
        appshell.fs.showOpenDialog(allowMultipleSelection, chooseDirectories, title, initialPath, fileTypes, _wrap(callback));
    }

    /**
     * Display a save-file dialog and call back asynchronously with either a
     * FileSystemError string or the path to which the user has chosen to save
     * the file. If the dialog is cancelled, the path string will be empty.
     *
     * @param {string} title
     * @param {string} initialPath
     * @param {string} proposedNewFilename
     * @param {function(?string, string=)} callback
     */
    function showSaveDialog(title, initialPath, proposedNewFilename, callback) {
        appshell.fs.showSaveDialog(title, initialPath, proposedNewFilename, _wrap(callback));
    }

    /**
     * Stat the file or directory at the given path, calling back
     * asynchronously with either a FileSystemError string or the entry's
     * associated FileSystemStats object.
     *
     * @param {string} path
     * @param {function(?string, FileSystemStats=)} callback
     */
    function stat(path, callback) {
        appshell.fs.lstat(path, function (err, stats) {
            if (err) {
                callback(_mapError(err));
            } else {
                if (stats.isSymbolicLink()) {
                    // TODO: Implement realPath. If "filename" is a symlink,
                    // realPath should be the actual path to the linked object.
                    return callback(new Error("realPath for symbolic link is not implemented in appshell.fs.stat"));
                }

                var options = {
                    isFile: stats.isFile(),
                    mtime: stats.mtime,
                    size: stats.size,
                    realPath: stats.realPath,
                    hash: stats.mtime.getTime()
                };

                var fsStats = new FileSystemStats(options);

                callback(null, fsStats);
            }
        });
    }

    /**
     * Determine whether a file or directory exists at the given path by calling
     * back asynchronously with either a FileSystemError string or a boolean,
     * which is true if the file exists and false otherwise. The error will never
     * be FileSystemError.NOT_FOUND; in that case, there will be no error and the
     * boolean parameter will be false.
     *
     * @param {string} path
     * @param {function(?string, boolean)} callback
     */
    function exists(path, callback) {
        stat(path, function (err) {
            if (err) {
                if (err === FileSystemError.NOT_FOUND) {
                    callback(null, false);
                } else {
                    callback(err);
                }
                return;
            }

            callback(null, true);
        });
    }

    /**
     * Read the contents of the directory at the given path, calling back
     * asynchronously either with a FileSystemError string or an array of
     * FileSystemEntry objects along with another consistent array, each index
     * of which either contains a FileSystemStats object for the corresponding
     * FileSystemEntry object in the second parameter or a FileSystemError
     * string describing a stat error.
     *
     * @param {string} path
     * @param {function(?string, Array.<FileSystemEntry>=, Array.<string|FileSystemStats>=)} callback
     */
    function readdir(path, callback) {
        appshell.fs.readdir(path, function (err, contents) {
            if (err) {
                callback(_mapError(err));
                return;
            }

            var count = contents.length;
            if (!count) {
                callback(null, [], []);
                return;
            }

            var stats: any[] = [];
            contents.forEach(function (val, idx) {
                stat(path + "/" + val, function (err, stat) {
                    stats[idx] = err || stat;
                    count--;
                    if (count <= 0) {
                        callback(null, contents, stats);
                    }
                });
            });
        });
    }

    /**
     * Create a directory at the given path, and call back asynchronously with
     * either a FileSystemError string or a stats object for the newly created
     * directory. The octal mode parameter is optional; if unspecified, the mode
     * of the created directory is implementation dependent.
     *
     * @param {string} path
     * @param {number=} mode The base-eight mode of the newly created directory.
     * @param {function(?string, FileSystemStats=)=} callback
     */
    function mkdir(path, mode, callback) {
        if (typeof mode === "function") {
            callback = mode;
            mode = parseInt("0755", 8);
        }
        appshell.fs.mkdir(path, mode, function (err) {
            if (err) {
                callback(_mapError(err));
            } else {
                stat(path, function (err, stat) {
                    callback(err, stat);
                });
            }
        });
    }

    /**
     * Rename the file or directory at oldPath to newPath, and call back
     * asynchronously with a possibly null FileSystemError string.
     *
     * @param {string} oldPath
     * @param {string} newPath
     * @param {function(?string)=} callback
     */
    function rename(oldPath, newPath, callback) {
        appshell.fs.rename(oldPath, newPath, _wrap(callback));
    }

    /**
     * Read the contents of the file at the given path, calling back
     * asynchronously with either a FileSystemError string, or with the data and
     * the FileSystemStats object associated with the read file. The options
     * parameter can be used to specify an encoding (default "utf8"), and also
     * a cached stats object that the implementation is free to use in order
     * to avoid an additional stat call.
     *
     * Note: if either the read or the stat call fails then neither the read data
     * nor stat will be passed back, and the call should be considered to have failed.
     * If both calls fail, the error from the read call is passed back.
     *
     * @param {string} path
     * @param {{encoding: string=, stat: FileSystemStats=}} options
     * @param {function(?string, string=, FileSystemStats=)} callback
     */
    function readFile(path, options, callback) {
        var encoding = options.encoding || "utf8";

        // callback to be executed when the call to stat completes
        //  or immediately if a stat object was passed as an argument
        function doReadFile(stat) {
            if (stat.size > (FileUtils.MAX_FILE_SIZE)) {
                callback(FileSystemError.EXCEEDS_MAX_FILE_SIZE);
            } else {
                appshell.fs.readTextFile(path, encoding, function (_err, _data) {
                    if (_err) {
                        callback(_mapError(_err));
                    } else {
                        callback(null, _data, stat);
                    }
                });
            }
        }

        if (options.stat) {
            doReadFile(options.stat);
        } else {
            exports.stat(path, function (_err, _stat) {
                if (_err) {
                    callback(_err);
                } else {
                    doReadFile(_stat);
                }
            });
        }
    }
    /**
     * Write data to the file at the given path, calling back asynchronously with
     * either a FileSystemError string or the FileSystemStats object associated
     * with the written file and a boolean that indicates whether the file was
     * created by the write (true) or not (false). If no file exists at the
     * given path, a new file will be created. The options parameter can be used
     * to specify an encoding (default "utf8"), an octal mode (default
     * unspecified and implementation dependent), and a consistency hash, which
     * is used to the current state of the file before overwriting it. If a
     * consistency hash is provided but does not match the hash of the file on
     * disk, a FileSystemError.CONTENTS_MODIFIED error is passed to the callback.
     *
     * @param {string} path
     * @param {string} data
     * @param {{encoding : string=, mode : number=, expectedHash : object=, expectedContents : string=}} options
     * @param {function(?string, FileSystemStats=, boolean)} callback
     */
    function writeFile(path, data, options, callback) {
        var encoding = options.encoding || "utf8";

        function _finishWrite(created) {
            appshell.fs.writeFile(path, data, encoding, function (err) {
                if (err) {
                    callback(_mapError(err));
                } else {
                    stat(path, function (err, stat) {
                        callback(err, stat, created);
                    });
                }
            });
        }

        stat(path, function (err, stats) {
            if (err) {
                switch (err) {
                case FileSystemError.NOT_FOUND:
                    _finishWrite(true);
                    break;
                default:
                    callback(err);
                }
                return;
            }

            if (options.hasOwnProperty("expectedHash") && options.expectedHash !== stats._hash) {
                console.error("Blind write attempted: ", path, stats._hash, options.expectedHash);

                if (options.hasOwnProperty("expectedContents")) {
                    appshell.fs.readTextFile(path, encoding, function (_err, _data) {
                        if (_err || _data !== options.expectedContents) {
                            callback(FileSystemError.CONTENTS_MODIFIED);
                            return;
                        }

                        _finishWrite(false);
                    });
                    return;
                } else {
                    callback(FileSystemError.CONTENTS_MODIFIED);
                    return;
                }
            }

            _finishWrite(false);
        });
    }

    /**
     * Unlink (i.e., permanently delete) the file or directory at the given path,
     * calling back asynchronously with a possibly null FileSystemError string.
     * Directories will be unlinked even when non-empty.
     *
     * @param {string} path
     * @param {function(string)=} callback
     */
    function unlink(path, callback) {
        // WARN: unlink is actually not supposed to work for directories
        appshell.fs.remove(path, function (err) {
            callback(_mapError(err));
        });
    }

    /**
     * Move the file or directory at the given path to a system dependent trash
     * location, calling back asynchronously with a possibly null FileSystemError
     * string. Directories will be moved even when non-empty.
     *
     * @param {string} path
     * @param {function(string)=} callback
     */
    function moveToTrash(path, callback) {
        appshell.fs.moveToTrash(path, function (err) {
            callback(_mapError(err));
        });
    }

    /**
     * Initialize file watching for this filesystem, using the supplied
     * changeCallback to provide change notifications. The first parameter of
     * changeCallback specifies the changed path (either a file or a directory);
     * if this parameter is null, it indicates that the implementation cannot
     * specify a particular changed path, and so the callers should consider all
     * paths to have changed and to update their state accordingly. The second
     * parameter to changeCallback is an optional FileSystemStats object that
     * may be provided in case the changed path already exists and stats are
     * readily available. The offlineCallback will be called in case watchers
     * are no longer expected to function properly. All watched paths are
     * cleared when the offlineCallback is called.
     *
     * @param {function(?string, FileSystemStats=)} changeCallback
     * @param {function()=} offlineCallback
     */
    function initWatchers(changeCallback, offlineCallback) {
        _changeCallback = changeCallback;
        _offlineCallback = offlineCallback;
    }

    /**
     * Start providing change notifications for the file or directory at the
     * given path, calling back asynchronously with a possibly null FileSystemError
     * string when the initialization is complete. Notifications are provided
     * using the changeCallback function provided by the initWatchers method.
     * Note that change notifications are only provided recursively for directories
     * when the recursiveWatch property of this module is true.
     *
     * @param {string} path
     * @param {function(?string)=} callback
     */
    function watchPath(path, callback) {
        appshell.fs.isNetworkDrive(path, function (err, isNetworkDrive) {
            if (err || isNetworkDrive) {
                if (isNetworkDrive) {
                    callback(FileSystemError.NETWORK_DRIVE_NOT_SUPPORTED);
                } else {
                    callback(FileSystemError.UNKNOWN);
                }
                return;
            }
            workerSend("watchPath", path, callback);
        });
    }
    /**
     * Stop providing change notifications for the file or directory at the
     * given path, calling back asynchronously with a possibly null FileSystemError
     * string when the operation is complete.
     *
     * @param {string} path
     * @param {function(?string)=} callback
     */
    function unwatchPath(path, callback) {
        workerSend("unwatchPath", path, callback);
    }

    /**
     * Stop providing change notifications for all previously watched files and
     * directories, optionally calling back asynchronously with a possibly null
     * FileSystemError string when the operation is complete.
     *
     * @param {function(?string)=} callback
     */
    function unwatchAll(callback) {
        workerSend("unwatchAll", null, callback);
    }


    // Export public API
    exports.showOpenDialog  = showOpenDialog;
    exports.showSaveDialog  = showSaveDialog;
    exports.exists          = exists;
    exports.readdir         = readdir;
    exports.mkdir           = mkdir;
    exports.rename          = rename;
    exports.stat            = stat;
    exports.readFile        = readFile;
    exports.writeFile       = writeFile;
    exports.unlink          = unlink;
    exports.moveToTrash     = moveToTrash;
    exports.initWatchers    = initWatchers;
    exports.watchPath       = watchPath;
    exports.unwatchPath     = unwatchPath;
    exports.unwatchAll      = unwatchAll;

    /**
     * Indicates whether or not recursive watching notifications are supported
     * by the watchPath call. Currently, only Darwin supports recursive watching.
     *
     * @type {boolean}
     */
    exports.recursiveWatch = true;

    /**
     * Indicates whether or not the filesystem should expect and normalize UNC
     * paths. If set, then //server/directory/ is a normalized path; otherwise the
     * filesystem will normalize it to /server/directory. Currently, UNC path
     * normalization only occurs on Windows.
     *
     * @type {boolean}
     */
    exports.normalizeUNCPaths = appshell.platform === "win";
});