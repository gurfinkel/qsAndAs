import React, { useEffect, useState, useRef } from 'react';

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faBug,
    faComments,
    faCommentDots,
    faMicrophone,
    faStop,
    faTrashAlt
} from "@fortawesome/free-solid-svg-icons";

import {v4 as uuid} from "uuid";

export default function RecorderAndTranscriber() {
    const initialRecorderState = {
        seconds: 0,
        stream: null,
        recorder: null,
    };
    const audioType = 'audio/ogg; codecs=opus';

    const savedCallback = useRef();
    const [recorderState, setRecorderState] = useState(initialRecorderState);
    const [records, setRecords] = useState([]);
    const [speeches, setSpeeches] = useState([]);
    const [transcriptions, setTranscriptions] = useState([]);
    const [wordErrorRates, setWordErrorRates] = useState([]);

    const handleStart = function() {
        if (recorderState.recorder && 'inactive' === recorderState.recorder.state) {
            const chunks = [];

            savedCallback.current = timerCallback;
            recorderState.recorder.start();

            recorderState.recorder.ondataavailable = (e) => {
                chunks.push(e.data);
            };

            recorderState.recorder.onstop = () => {
                const blob = new Blob(chunks, { type: audioType });

                setRecords((prevState) => {
                    return [...prevState, {key: uuid(), audio: window.URL.createObjectURL(blob), blob: blob}];
                });
                setRecorderState((prevState) => {
                    return {
                        ...prevState,
                        seconds: 0,
                    };
                });
            };
        }
    }

    const handleStop = function() {
        if (recorderState.recorder && 'recording' === recorderState.recorder.state) {
            savedCallback.current = () => {};
            recorderState.recorder.stop();
        }
    }

    const deleteAudio = function(key) {
        setRecords((prevState) => prevState.filter((item) => key !== item.key));
    }

    const transcribeAudio = async function(key) {
        const recordToTranscribe = records.find((item) => key === item.key);

        if (!recordToTranscribe) {
            console.error(`Filed to find the record with id: ${key}`);
            return;
        }

        const formData = new FormData();
        formData.append("audio", recordToTranscribe.blob, 'myRecord.wav');

        const rawResponse = await fetch('api/transcription', {
            method: 'POST',
            headers: { 'Accept': 'application/json' },
            body: formData
        });
        const content = await rawResponse.json();

        setTranscriptions((prevState) => {
            return [...prevState, {key: key, transcription: content.data}];
        });
    }

    const getAnswer = async function(key) {
        const transcriptionToCheck = transcriptions.find((item) => key === item.key);

        if (!transcriptionToCheck) {
            console.error(`Filed to find the transcription with id: ${key}`);
            return;
        }

        const params = new URLSearchParams({question: transcriptionToCheck.transcription}).toString();
        const rawResponse = await fetch(`api/answer?${params}`);
        const content = await rawResponse.json();
        const blob = new Blob([new Uint8Array(content.audio.data)]);

        setSpeeches((prevState) => {
            return [...prevState, {key: key, answer: content.answer, audio: window.URL.createObjectURL(blob)}];
        });
    }

    const getWordErrorRates = async function(key) {
        const transcriptionToCheck = transcriptions.find((item) => key === item.key);

        if (!transcriptionToCheck) {
            console.error(`Filed to find the transcription with id: ${key}`);
            return;
        }

        const hypothesis = transcriptionToCheck.transcription;
        const reference = transcriptionToCheck.text ? transcriptionToCheck.text : '';
        const params = new URLSearchParams({hypothesis: hypothesis, reference: reference}).toString();
        const rawResponse = await fetch(`api/wer?${params}`);
        const content = await rawResponse.json();

        setWordErrorRates((prevState) => {
            return [
                ...prevState.filter((item) => key !== item.key),
                {key: key, summary: content.summary, details: content.details, html: content.html}
            ];
        });
    }

    const timerCallback = function() {
        setRecorderState((prevState) => {
            if (0 <= prevState.seconds && 9 > prevState.seconds) {
                return {
                    ...prevState,
                    seconds: 1 + prevState.seconds,
                };
            } else {
                handleStop();

                return prevState;
            }
        });
    }

    useEffect(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            setRecorderState((prevState) => {
                return {
                    ...prevState,
                    stream,
                };
            });
        } catch (err) {
            console.log(err);
        }
    }, []);

    useEffect(() => {
        if (recorderState.stream) {
            setRecorderState((prevState) => {
                return {
                    ...prevState,
                    recorder: new MediaRecorder(recorderState.stream),
                };
            });
        }
    }, [recorderState.stream]);

    useEffect(() => {
        savedCallback.current = () => {};

        function tick() {
            savedCallback.current();
        }

        let intervalId = setInterval(tick, 1000);
        return () => clearInterval(intervalId);
    }, []);

    return (
        <div className='container'>
            <div className='recorder-container'>
                <div className='timer-container'>
                    <div className="timer">
                        <span>00</span>
                        <span>:</span>
                        <span>{10 > recorderState.seconds  ? `0${recorderState.seconds}` : recorderState.seconds}</span>
                    </div>
                </div>
                <div className="button-container">
                    <button
                        className="start-button"
                        title="Start"
                        disabled={0 !== recorderState.seconds}
                        onClick={handleStart}
                    >
                        <FontAwesomeIcon icon={faMicrophone} size="2x" />
                    </button>
                    <button
                        className='stop-button'
                        title='Stop'
                        disabled={0 === recorderState.seconds}
                        onClick={handleStop}
                    >
                        <FontAwesomeIcon icon={faStop} size="2x" />
                    </button>
                </div>
            </div>
            <div className='records-container'>
                {records.length > 0 ? (
                    records.map((record) => (
                        <div className='record-container' key={record.key}>
                            <div className='record'>
                                <audio controls src={record.audio} />
                                <div className='button-container'>
                                    <button
                                        className='delete-button'
                                        title='Delete this audio'
                                        onClick={() => deleteAudio(record.key)}
                                    >
                                        <FontAwesomeIcon icon={faTrashAlt} />
                                    </button>
                                    <button
                                        className='transcribe-button'
                                        title='Transcribe record'
                                        onClick={() => transcribeAudio(record.key)}
                                    >
                                        <FontAwesomeIcon icon={faCommentDots} />
                                    </button>
                                    <button
                                        className='wer-button'
                                        title='Get Word Error Rate for record'
                                        onClick={() => getWordErrorRates(record.key)}
                                    >
                                        <FontAwesomeIcon icon={faBug} />
                                    </button>
                                    <button
                                        className='speech-button'
                                        title='Get Speech for record'
                                        onClick={() => getAnswer(record.key)}
                                    >
                                        <FontAwesomeIcon icon={faComments} />
                                    </button>
                                </div>
                            </div>
                            {transcriptions.find((item) => item.key === record.key) ? (
                                <div className='transcriptions-container'>
                                    <div className='transcriptions-ai'>
                                        <h4>Transcription from AI:</h4>
                                        <div>{transcriptions.find((item) => item.key === record.key).transcription}</div>
                                    </div>
                                    <div className='transcriptions-manual'>
                                        <h4>Transcription from you:</h4>
                                        <textarea
                                            className='transcription-manual'
                                            rows='3'
                                            wrap='soft'
                                            onInput={e => transcriptions.find((item) => item.key === record.key).text = e.target.value} />
                                    </div>
                                </div>
                            ) : (
                                <></>
                            )}
                            <div className='wer-container'>
                                {wordErrorRates.find((item) => item.key === record.key) ? (
                                    <div>
                                        <h4>Word Error Rate:</h4>
                                        <div>{wordErrorRates.find((item) => item.key === record.key).summary}</div>
                                        <div>{wordErrorRates.find((item) => item.key === record.key).details}</div>
                                        <div dangerouslySetInnerHTML={{ __html: wordErrorRates.find((item) => item.key === record.key).html}} />
                                    </div>
                                ) : (
                                    <></>
                                )}
                            </div>
                            <div>
                                {speeches.find((item) => item.key === record.key) ? (
                                    <div className="record">
                                        <audio controls src={speeches.find((item) => item.key === record.key).audio} />
                                    </div>
                                ) : (
                                    <></>
                                )}
                            </div>
                        </div>
                    ))
                ) : (
                    <></>
                )}
            </div>
        </div>
    );
}
