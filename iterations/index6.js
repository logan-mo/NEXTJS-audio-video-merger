const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // For generating a random folder name

ffmpeg.setFfmpegPath(ffmpegPath);

// Toggle DEBUG mode
const DEBUG = true; // Set to false to disable debug logs

function debugLog(...messages) {
    if (DEBUG) {
        console.log('[DEBUG]', ...messages);
    }
}

// Function to generate a random folder name
function generateRandomFolderName() {
    return crypto.randomBytes(16).toString('hex'); // Generate a random 16-byte hex string
}

/**
 * Get the duration of a media file (audio or video).
 * 
 * @param {string} filePath - Path to the media file.
 * @returns {Promise} - Resolves with the duration in seconds.
 */
function getDuration(filePath) {
    debugLog(`Getting duration for: ${filePath}`);
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                debugLog(`Error getting duration: ${err.message}`);
                return reject(err);
            }
            const duration = metadata.format.duration;
            debugLog(`Duration for ${filePath}: ${duration} seconds`);
            resolve(duration);
        });
    });
}

// Function to create a temporary directory
function createTempDirectory() {
    const tempDir = path.join(__dirname, generateRandomFolderName());
    fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

/**
 * Detect silent pauses in the audio using FFmpeg.
 * 
 * @param {string} audioPath - Path to the audio file.
 * @returns {Promise} - Resolves with an array of detected silence periods.
 */
function detectSilences(audioPath) {
    debugLog(`Detecting silences in audio: ${audioPath}`);
    return new Promise((resolve, reject) => {
        const silenceTimes = [];

        // Run the FFmpeg command with the silencedetect filter
        ffmpeg(audioPath)
            .audioFilters('silencedetect=n=-50dB:d=0.5') // Set the silence detection parameters
            .addOption('-f', 'null')  // set format to null 
            .on('stderr', (line) => {
                // Match and capture silence start and end times
                const silenceStartMatch = line.match(/silence_start: (\d+\.\d+)/);
                const silenceEndMatch = line.match(/silence_end: (\d+\.\d+)/);

                if (silenceStartMatch) {
                    silenceTimes.push({ type: 'start', time: parseFloat(silenceStartMatch[1]) });
                    debugLog(`Detected silence start at: ${silenceStartMatch[1]} seconds`);
                }
                if (silenceEndMatch) {
                    silenceTimes.push({ type: 'end', time: parseFloat(silenceEndMatch[1]) });
                    debugLog(`Detected silence end at: ${silenceEndMatch[1]} seconds`);
                }
            })
            .on('end', () => {
                debugLog(`Silence detection complete for: ${audioPath}`);
                resolve(silenceTimes);
            })
            .on('error', (err) => {
                debugLog(`Error in silence detection: ${err.message}`);
                reject(err);
            })
            .output('nowhere')
            .run(); // Execute the command
    });
}

/**
 * Adds silence to the audio to align with the video length.
 * 
 * @param {string} audioPath - Path to the audio file.
 * @param {number} videoDuration - Duration of the video in seconds.
 * @param {string} outputAudioPath - Path to save the extended audio file.
 * @param {string} tempDir - Temporary directory to store intermediate files.
 * @returns {Promise} - Resolves when the audio is extended and saved.
 */
function extendAudioWithSilence(audioPath, videoDuration, outputAudioPath, tempDir) {
    debugLog(`Extending audio with silence: ${audioPath}`);
    return detectSilences(audioPath)
        .then((silenceTimes) => {
            const audioChunks = [];
            let lastEndTime = 0;

            silenceTimes.forEach((silence) => {
                if (silence.type === 'start') {
                    if (lastEndTime < silence.time) {
                        audioChunks.push({ start: lastEndTime, end: silence.time });
                    }
                } else if (silence.type === 'end') {
                    lastEndTime = silence.time; // Update last end time to the end of the current silence
                }
            });

            const audioDuration = lastEndTime;
            if (audioDuration > lastEndTime) {
                audioChunks.push({ start: lastEndTime, end: audioDuration });
            }

            debugLog(`Detected ${audioChunks.length} audio chunks between silences.`);

            const totalSilenceNeeded = videoDuration - audioDuration;
            const silencePerChunk = totalSilenceNeeded / audioChunks.length;
            debugLog(`Total silence needed: ${totalSilenceNeeded} seconds. Silence per chunk: ${silencePerChunk} seconds.`);

            return Promise.all(audioChunks.map((chunk, index) => {
                const chunkAudioPath = path.join(tempDir, `chunk-${index}.mp3`);

                return new Promise((resolve, reject) => {
                    ffmpeg(audioPath)
                        .setStartTime(chunk.start)
                        .setDuration(chunk.end - chunk.start)
                        .save(chunkAudioPath)
                        .on('end', () => {
                            debugLog(`Created audio chunk: ${chunkAudioPath}`);
                            resolve({ chunkAudioPath, silenceDuration: Math.min(silencePerChunk, 5) });
                        })
                        .on('error', (err) => {
                            debugLog(`Error creating audio chunk: ${err.message}`);
                            reject(err);
                        });
                });
            }))
                .then((chunkResults) => {
                    return Promise.all(chunkResults.map(({ chunkAudioPath, silenceDuration }, index) => {
                        return new Promise((resolve, reject) => {
                            const mergedFilePath = path.join(tempDir, `merged-${index}.mp3`);

                            ffmpeg()
                                .input(chunkAudioPath)
                                .outputOptions(`-filter_complex`, `anullsrc=r=44100:cl=stereo:d=${silenceDuration}[silence];[0:a][silence]concat=n=2:v=0:a=1[out]`)
                                .outputOptions('-map', '[out]')
                                .save(mergedFilePath)
                                .on('end', () => {
                                    debugLog(`Merged audio chunk with silence: ${mergedFilePath}`);
                                    resolve(mergedFilePath);
                                })
                                .on('error', (err) => {
                                    debugLog(`Error merging audio chunk: ${err.message}`);
                                    reject(err);
                                });
                        });
                    }));
                })
                .then((mergedFiles) => {
                    return new Promise((resolve, reject) => {
                        const finalOutputFile = outputAudioPath;

                        const ffmpegCommand = ffmpeg();
                        mergedFiles.forEach((file) => {
                            ffmpegCommand.input(file);
                        });

                        ffmpegCommand
                            .outputOptions(`-filter_complex`, `concat=n=${mergedFiles.length}:v=0:a=1[out]`)
                            .outputOptions('-map', '[out]')
                            .save(finalOutputFile)
                            .on('end', () => {
                                debugLog(`Extended audio saved: ${finalOutputFile}`);
                                resolve(finalOutputFile);
                            })
                            .on('error', (err) => {
                                debugLog(`Error merging final audio: ${err.message}`);
                                reject(err);
                            });
                    });
                });
        });
}

/**
 * Loop the video to match the length of the audio if the video is shorter.
 * 
 * @param {string} videoPath - Path to the video file.
 * @param {number} videoDuration - Duration of the video in seconds.
 * @param {number} audioDuration - Duration of the audio in seconds.
 * @param {string} outputLoopedVideoPath - Path to save the looped video.
 * @param {string} tempDir - Temporary directory to store intermediate files.
 * @returns {Promise} - Resolves when the video is looped and saved.
 */
function loopVideo(videoPath, videoDuration, audioDuration, outputLoopedVideoPath, tempDir) {
    debugLog(`Looping video: ${videoPath}`);
    return new Promise((resolve, reject) => {
        if (audioDuration <= videoDuration) {
            debugLog(`No need to loop video, returning original: ${videoPath}`);
            return resolve(videoPath);
        }

        const loopCount = Math.ceil(audioDuration / videoDuration);
        debugLog(`Looping video ${loopCount} times to match audio length`);

        ffmpeg()
            .input(videoPath)
            .inputOptions(`-stream_loop ${loopCount - 1}`)
            .outputOptions('-t', audioDuration)
            .save(outputLoopedVideoPath)
            .on('end', () => {
                debugLog(`Looped video saved: ${outputLoopedVideoPath}`);
                resolve(outputLoopedVideoPath);
            })
            .on('error', (err) => {
                debugLog(`Error looping video: ${err.message}`);
                reject(err);
            });
    });
}

/**
 * Merge audio and video files.
 * 
 * @param {string} videoPath - Path to the video file.
 * @param {string} audioPath - Path to the audio file.
 * @param {string} outputPath - Path to save the merged video and audio.
 */
async function mergeAudioVideo(videoPath, audioPath, outputPath) {
    const tempDir = createTempDirectory(); // Create a temporary directory

    try {
        const videoDuration = await getDuration(videoPath);
        const audioDuration = await getDuration(audioPath);

        const outputAudioPath = path.join(tempDir, 'extended-audio.mp3');
        const outputLoopedVideoPath = path.join(tempDir, 'looped-video.mp4');

        await extendAudioWithSilence(audioPath, videoDuration, outputAudioPath, tempDir);
        await loopVideo(videoPath, videoDuration, audioDuration, outputLoopedVideoPath, tempDir);

        // Merge the extended audio and looped video
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(outputLoopedVideoPath)
                .input(outputAudioPath)
                .outputOptions('-c:v', 'copy')
                .outputOptions('-c:a', 'aac')
                .save(outputPath)
                .on('end', () => {
                    debugLog(`Merged video and audio saved: ${outputPath}`);
                    resolve();
                })
                .on('error', (err) => {
                    debugLog(`Error merging video and audio: ${err.message}`);
                    reject(err);
                });
        });
    } catch (error) {
        debugLog(`Error in merge process: ${error.message}`);
    } finally {
        // Clean up the temporary directory
        fs.rmSync(tempDir, { recursive: true, force: true });
        debugLog(`Cleaned up temporary directory: ${tempDir}`);
    }
}

// Example usage:
// Scenario 1 - when the input video is shorter than the audio, the video should loop
const videoFile = path.join(__dirname, 'input-video.mp4');

// Scenario 2 - when the input audio is shorter than the video, the audio should be extended
// const videoFilePath = path.join(__dirname, 'looped-input-video.mp4');

//const videoFile = 'path/to/video.mp4'; // Replace with your video file path
const audioFile = path.join(__dirname, 'input-audio.mp3'); // Replace with your audio file path
const outputMergedFile = path.join(__dirname, 'merged_video.mp4');; // Replace with your output file path

mergeAudioVideo(videoFile, audioFile, outputMergedFile)
    .then(() => debugLog('Merge process completed successfully'))
    .catch((err) => debugLog(`Merge process failed: ${err.message}`));
