const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');

// Set FFmpeg binary path
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Detect silent pauses in the audio using FFmpeg.
 * 
 * @param {string} audioPath - Path to the audio file.
 * @returns {Promise} - Resolves with an array of detected silence periods.
 */
function detectSilences(audioPath) {
    return new Promise((resolve, reject) => {
        const silenceTimes = [];
        ffmpeg(audioPath)
            .audioFilters('silencedetect=n=-50dB:d=0.5') // Threshold: -50dB, Silence duration: 0.5 sec
            .on('stderr', (line) => {
                const silenceStartMatch = line.match(/silence_start: (\d+\.\d+)/);
                const silenceEndMatch = line.match(/silence_end: (\d+\.\d+)/);
                if (silenceStartMatch) {
                    silenceTimes.push({ type: 'start', time: parseFloat(silenceStartMatch[1]) });
                }
                if (silenceEndMatch) {
                    silenceTimes.push({ type: 'end', time: parseFloat(silenceEndMatch[1]) });
                }
            })
            .on('end', () => {
                resolve(silenceTimes);
            })
            .on('error', (err) => {
                reject(err);
            })
            .run();
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
    return detectSilences(audioPath)
        .then((silenceTimes) => {
            const totalSilenceTime = silenceTimes.reduce((total, current, idx, arr) => {
                if (current.type === 'end' && arr[idx - 1] && arr[idx - 1].type === 'start') {
                    return total + (current.time - arr[idx - 1].time);
                }
                return total;
            }, 0);

            const additionalSilenceNeeded = videoDuration - totalSilenceTime;
            if (additionalSilenceNeeded <= 0) {
                return Promise.resolve(audioPath);  // No need to extend
            }

            const silenceDuration = Math.min(additionalSilenceNeeded, 5); // Insert pauses max of 5 seconds at each break
            const silentFilePath = path.join(__dirname, 'silence.mp3');

            // Use FFmpeg to create a silent audio clip
            return new Promise((resolve, reject) => {
                ffmpeg()
                    .input('anullsrc=r=44100:cl=stereo')
                    .outputOptions(`-t ${silenceDuration}`)
                    .save(silentFilePath)
                    .on('end', () => resolve(silentFilePath))
                    .on('error', reject);
            });
        })
        .then((silentFilePath) => {
            // Merge the silent segments with the original audio to extend
            return new Promise((resolve, reject) => {
                ffmpeg()
                    .input(audioPath)
                    .input(silentFilePath)
                    .outputOptions('-filter_complex', `[0:a][1:a]concat=n=2:v=0:a=1[a]`)
                    .outputOptions('-map', '[a]')
                    .save(outputAudioPath)
                    .on('end', () => resolve(outputAudioPath))
                    .on('error', reject);
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
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoPath)
            .input(extendedAudioPath)
            .outputOptions('-c:v copy')  // Copy video codec without re-encoding
            .outputOptions('-c:a aac')   // Re-encode audio to AAC
            .save(outputVideoPath)
            .on('end', () => resolve(outputVideoPath))
            .on('error', reject);
    });
}


// /**
//  * Merges an audio file and a video file into a single video with audio.
//  * 
//  * @param {string} videoPath - The path to the video file.
//  * @param {string} audioPath - The path to the audio file.
//  * @param {string} outputPath - The path where the output file should be saved.
//  * @returns {Promise} - Resolves when the merging is done, rejects on error.
//  */
// function mergeAudioVideo(videoPath, audioPath, outputPath) {
//     return new Promise((resolve, reject) => {
//         ffmpeg()
//             .input(videoPath)  // Input video file
//             .input(audioPath)  // Input audio file
//             .outputOptions('-c:v copy')  // Copy video codec without re-encoding
//             .outputOptions('-c:a aac')  // Encode audio to AAC
//             .outputOptions('-strict experimental')  // Enable experimental codecs if needed
//             .save(outputPath)  // Save to the specified output path
//             .on('end', () => {
//                 console.log('Merging complete!');
//                 resolve(outputPath);  // Resolves when the merge is done
//             })
//             .on('error', (err) => {
//                 console.error('Error: ', err);
//                 reject(err);  // Rejects if there's an error
//             });
//     });
// }

// // Example usage
// const videoFilePath = path.join(__dirname, 'input-video.mp4');
// const audioFilePath = path.join(__dirname, 'input-audio.mp3');
// const outputFilePath = path.join(__dirname, 'output-video-with-audio.mp4');

// mergeAudioVideo(videoFilePath, audioFilePath, outputFilePath)
//     .then((outputPath) => {
//         console.log('Merged file saved to:', outputPath);
//     })
//     .catch((err) => {
//         console.error('Error merging audio and video:', err);
//     });

const videoFilePath = path.join(__dirname, 'input-video.mp4');
const audioFilePath = path.join(__dirname, 'input-audio.mp3');
const extendedAudioPath = path.join(__dirname, 'extended-audio.mp3');
const outputVideoPath = path.join(__dirname, 'output-video-with-audio.mp4');

// Get the video duration using FFmpeg
ffmpeg.ffprobe(videoFilePath, (err, metadata) => {
    const videoDuration = metadata.format.duration;

    extendAudioWithSilence(audioFilePath, videoDuration, extendedAudioPath)
        .then(() => {
            return mergeAudioVideo(videoFilePath, extendedAudioPath, outputVideoPath);
        })
        .then(() => {
            console.log('Audio and video successfully merged!');
        })
        .catch((err) => {
            console.error('Error processing files:', err);
        });
});

