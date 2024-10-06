const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

// Toggle DEBUG mode
const DEBUG = true; // Set to false to disable debug logs

function debugLog(...messages) {
    if (DEBUG) {
        console.log('[DEBUG]', ...messages);
    }
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
 * @returns {Promise} - Resolves when the audio is extended and saved.
 */
function extendAudioWithSilence(audioPath, videoDuration, outputAudioPath) {
    debugLog(`Extending audio with silence: ${audioPath}`);
    return detectSilences(audioPath)
        .then((silenceTimes) => {
            const totalSilenceTime = silenceTimes.reduce((total, current, idx, arr) => {
                if (current.type === 'end' && arr[idx - 1] && arr[idx - 1].type === 'start') {
                    return total + (current.time - arr[idx - 1].time);
                }
                return total;
            }, 0);

            const additionalSilenceNeeded = videoDuration - totalSilenceTime;
            debugLog(`Total silence time: ${totalSilenceTime} seconds, additional silence needed: ${additionalSilenceNeeded} seconds`);

            if (additionalSilenceNeeded <= 0) {
                debugLog(`No need to extend audio, returning original: ${audioPath}`);
                return Promise.resolve(audioPath);  // No need to extend
            }

            const silenceDuration = Math.min(additionalSilenceNeeded, 5); // Insert pauses max of 5 seconds at each break
            const silentFilePath = path.join(__dirname, 'silence.mp3');

            debugLog(`Creating silent audio of duration: ${silenceDuration} seconds`);
            return new Promise((resolve, reject) => {
                ffmpeg()
                    .input('anullsrc=r=44100:cl=stereo')
                    .outputOptions(`-t ${silenceDuration}`)
                    .save(silentFilePath)
                    .on('end', () => {
                        debugLog(`Silence audio created: ${silentFilePath}`);
                        resolve(silentFilePath);
                    })
                    .on('error', (err) => {
                        debugLog(`Error creating silence audio: ${err.message}`);
                        reject(err);
                    });
            });
        })
        .then((silentFilePath) => {
            debugLog(`Merging original audio with silence: ${audioPath} and ${silentFilePath}`);
            return new Promise((resolve, reject) => {
                ffmpeg()
                    .input(audioPath)
                    .input(silentFilePath)
                    .outputOptions('-filter_complex', `[0:a][1:a]concat=n=2:v=0:a=1[a]`)
                    .outputOptions('-map', '[a]')
                    .save(outputAudioPath)
                    .on('end', () => {
                        debugLog(`Extended audio saved: ${outputAudioPath}`);
                        resolve(outputAudioPath);
                    })
                    .on('error', (err) => {
                        debugLog(`Error merging audio: ${err.message}`);
                        reject(err);
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
 * @returns {Promise} - Resolves when the video is looped and saved.
 */
function loopVideo(videoPath, videoDuration, audioDuration, outputLoopedVideoPath) {
    debugLog(`Looping video: ${videoPath}`);
    return new Promise((resolve, reject) => {
        if (audioDuration <= videoDuration) {
            debugLog(`No need to loop video, returning original: ${videoPath}`);
            return resolve(videoPath);  // No need to loop, return the original video
        }

        const loopCount = Math.ceil(audioDuration / videoDuration); // How many times to loop
        debugLog(`Looping video ${loopCount} times to match audio length`);

        ffmpeg()
            .input(videoPath)
            .inputOptions(`-stream_loop ${loopCount - 1}`)  // Loop the video (input option)
            .outputOptions('-t', audioDuration)  // Trim the looped video to match audio length (output option)
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
 * Merges the extended audio with the video.
 * 
 * @param {string} videoPath - Path to the video file.
 * @param {string} extendedAudioPath - Path to the extended audio file.
 * @param {string} outputVideoPath - Path to save the merged output video.
 * @returns {Promise} - Resolves when the merge is complete.
 */
function mergeAudioVideo(videoPath, extendedAudioPath, outputVideoPath) {
    debugLog(`Merging video: ${videoPath} with audio: ${extendedAudioPath}`);
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoPath)
            .input(extendedAudioPath)
            .outputOptions('-c:v copy')  // Copy video codec without re-encoding
            .outputOptions('-c:a aac')   // Re-encode audio to AAC
            .save(outputVideoPath)
            .on('end', () => {
                debugLog(`Merged video saved: ${outputVideoPath}`);
                resolve(outputVideoPath);
            })
            .on('error', (err) => {
                debugLog(`Error merging audio and video: ${err.message}`);
                reject(err);
            });
    });
}

// Example usage

// Scenario 1 - when the input video is shorter than the audio, the video should loop
//const videoFilePath = path.join(__dirname, 'input-video.mp4');

// Scenario 2 - when the input audio is shorter than the video, the audio should be extended
const videoFilePath = path.join(__dirname, 'looped-input-video.mp4');

const audioFilePath = path.join(__dirname, 'input-audio.mp3');
const outputLoopedVideoPath = path.join(__dirname, 'looped-video.mp4');
const outputVideoWithAudioPath = path.join(__dirname, 'output-video-with-audio.mp4');
const extendedAudioPath = path.join(__dirname, 'extended-audio.mp3');
const dummyAudioPath = path.join(__dirname, 'dummy.mp3');

async function processMedia() {
    try {
        const videoDuration = await getDuration(videoFilePath);
        const audioDuration = await getDuration(audioFilePath);

        debugLog(`Video duration: ${videoDuration} seconds, Audio duration: ${audioDuration} seconds`);

        let finalAudioPath = audioFilePath;
        let finalVideoPath = videoFilePath;

        if (audioDuration > videoDuration) {
            // Loop the video if the audio is longer
            finalVideoPath = await loopVideo(videoFilePath, videoDuration, audioDuration, outputLoopedVideoPath);
        } else if (videoDuration > audioDuration) {
            // Add pauses to the audio if the video is longer
            finalAudioPath = await extendAudioWithSilence(audioFilePath, videoDuration, extendedAudioPath);
        }

        // At this point, finalAudioPath and finalVideoPath should be of equal length
        const outputPath = await mergeAudioVideo(finalVideoPath, finalAudioPath, outputVideoWithAudioPath);

        console.log(`Merged video created at: ${outputPath}`);
    } catch (err) {
        console.error('Error processing files:', err);
    }
}
// Start processing
processMedia();
