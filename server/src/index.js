const keys = require('./../keys');

// Express App Setup
const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const speech = require('@google-cloud/speech');
const dgraph = require("dgraph-js-http");

const app = express();
const upload = multer();
const type = upload.single('audio');
const client = new speech.SpeechClient();

const dgraphCloudEndpoint = keys.dgraphHost;

//here we pass the cloud endpoint
const clientStub = new dgraph.DgraphClientStub(
    dgraphCloudEndpoint,
);

const dgraphClient = new dgraph.DgraphClient(clientStub);

//here we pass the API key
dgraphClient.setSlashApiKey(keys.dgraphKey);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Express route handlers
app.get('/health', (req, res) => {
    res.send('ready');
});

app.get('/answer', async (req, res) => {
    // question: Question string.
    const question = txtPreprocess(req.query.question);

    const answer = await getAnswerForQuestion(question);
    const speech = await getSpeech(answer);

    res.send({answer, audio: speech});
});

app.post('/answer', async (req, res) => {
    // answer: Answer string.
    const answer = txtPreprocess(req.query.answer);
    // question: Question string.
    const question = txtPreprocess(req.query.question);

    await postQuestionAndAnswer(question, answer);

    res.status(201).send('the answer and the questions were added to the db');
});

const postQuestionAndAnswer = async function(question, answer) {
    const questionWords = question.split(' ');
    const root = await getTrieRoot();
    let words = await getTrieNodeChildren(root.uid);
    let lastWordInTrie = !words[0]['TrieNode.nodes'] ? words[0] : null;
    let idx = 0;

    while (questionWords.length > idx && !lastWordInTrie) {
        const questionWord = questionWords[idx];

        for (let i = 0; words[0]['TrieNode.nodes'].length > i; ++i) {
            const word = words[0]['TrieNode.nodes'][i];

            if (questionWord === word['TrieNode.text']) {
                words = await getTrieNodeChildren(word.uid);
                break;
            }

            if (words[0]['TrieNode.nodes'].length === 1 + i) {
                lastWordInTrie = words[0];
                --idx;
            }
        }

        ++idx;
    }

    if (lastWordInTrie) {
        let trieNode = lastWordInTrie;

        while (questionWords.length > idx) {
            trieNode['TrieNode.nodes'] = [
                {
                    'TrieNode.text': questionWords[idx],
                    'TrieNode.isEnd': questionWords.length === 1 + idx,
                    'TrieNode.isRoot': false,
                }
            ];

            ++idx;

            trieNode = trieNode['TrieNode.nodes'][0];
        }

        trieNode['TrieNode.nodes'] = [
            {
                'TrieNode.text': answer,
                'TrieNode.isAnswer': true,
                'TrieNode.isEnd': false,
                'TrieNode.isRoot': false,
            }
        ];

        // Create a new transaction.
        const txn = dgraphClient.newTxn();

        try {
            // Run mutation.
            const assigned = await txn.mutate({ setJson: lastWordInTrie });

            // Commit transaction.
            await txn.commit();

            const newWordUid = assigned.data.uids;
            console.log(newWordUid);
        } catch (e) {
            if (e === dgraph.ERR_ABORTED) {
                // Retry or handle exception.
            } else {
                throw e;
            }
        } finally {
            // Clean up. Calling this after txn.commit() is a no-op
            // and hence safe.
            await txn.discard();
        }
    }
};

const getAnswerForQuestion = async function(question) {
    const questionWords = question.split(' ');
    const root = await getTrieRoot();
    let words = await getTrieNodeChildren(root.uid);
    let answer = `I don't have an answer for you!`;

    for (const questionWord of questionWords) {
        for (const word of words[0]['TrieNode.nodes']) {
            if (questionWord === word['TrieNode.text']) {
                words = await getTrieNodeChildren(word.uid);
                break;
            }
        }
    }

    if (words && 1 === words.length && words[0]['TrieNode.isEnd']) {
        answer = words[0]['TrieNode.nodes'][0]['TrieNode.text'];
    }

    return answer;
};

const getSpeech = async function(text) {
    // Imports the Google Cloud client library
    const textToSpeech = require('@google-cloud/text-to-speech');

    // Creates a client
    const client = new textToSpeech.TextToSpeechClient();
    // Construct the request
    const request = {
        input: {text: text},
        // Select the language and SSML voice gender (optional)
        voice: {languageCode: 'en-US', ssmlGender: 'NEUTRAL'},
        // select the type of audio encoding
        audioConfig: {audioEncoding: 'MP3'},
    };

    // Performs the text-to-speech request
    const [response] = await client.synthesizeSpeech(request);

    return response.audioContent;
};

const getTrieRoot = async function() {
    const query = `
        query {
          roots(func: eq(TrieNode.isRoot, true))
          {
            uid
          }
        }
    `;

    // Create a new transaction.
    const txn = dgraphClient.newTxn();

    try {
        // Run query.
        const res = await txn.query(query);

        // Commit transaction.
        await txn.commit();

        console.log(res.extensions.server_latency);

        return res.data.roots.length ? res.data.roots[0] : {};
    } catch (e) {
        if (e === dgraph.ERR_ABORTED) {
            // Retry or handle exception.
        } else {
            throw e;
        }
    } finally {
        // Clean up. Calling this after txn.commit() is a no-op
        // and hence safe.
        await txn.discard();
    }
};

const getTrieNodeChildren = async function(uid) {
    const query = `
        query all($a: string) {
          words(func: uid($a))
          {
            uid
            TrieNode.nodes {
              uid
              TrieNode.text
            }
            TrieNode.text
            TrieNode.isAnswer
            TrieNode.isEnd
            TrieNode.isRoot
          }
        }
    `;
    const vars = { $a: uid };
    const res = await dgraphClient.newTxn().queryWithVars(query, vars);

    console.log(res.extensions.server_latency);

    return res.data.words;
};

// get WER.html for one pair of strings: (hypothesis, reference).
app.get('/wer', (req, res) => {
    // hypothesis: Hypothesis string.
    const hypothesis = txtPreprocess(req.query.hypothesis);
    // reference: Reference string.
    const reference = txtPreprocess(req.query.reference);

    // Compute edit distance.
    const hypWords = hypothesis.split(' ');
    const refWords = reference.split(' ');
    const distmat = computeEditDistanceMatrix(hypWords, refWords);

    // Back trace, to distinguish different errors: ins, del, sub.
    let posHyp = hypWords.length;
    let posRef = refWords.length;
    const werInfo = {'sub': 0, 'ins': 0, 'del': 0, 'nw': refWords.length};

    let alignedHtml = '';
    let matchedRef = '';

    while (0 < posHyp || 0 < posRef) {
        let errType = '';

        // Distinguish error type by back tracking
        if (0 === posRef) {
            errType = 'ins';
        } else if (0 === posHyp) {
            errType = 'del';
        } else {
            if (hypWords[posHyp - 1] === refWords[posRef - 1]) {
                errType = 'none'; // correct error
            } else if (distmat[posRef][posHyp] === 1 + distmat[posRef - 1][posHyp - 1]) {
                errType = 'sub'; // substitute error
            } else if (distmat[posRef][posHyp] === 1 + distmat[posRef - 1][posHyp]) {
                errType = 'del'; // deletion error
            } else if (distmat[posRef][posHyp] === 1 + distmat[posRef][posHyp - 1]) {
                errType = 'ins'; // insertion error
            } else {
                throw new Error('fail to parse edit distance matrix.');
            }
        }

        // Generate aligned_html
        const tmph = (0 === posHyp || !hypWords) ? ' ' : hypWords[posHyp - 1];
        const tmpr = (0 === posRef || !refWords) ? ' ' : refWords[posRef - 1];

        alignedHtml = highlightAlignedHtml(tmph, tmpr, errType) + alignedHtml;

        // If no error, go to previous ref and hyp.
        if ('none' === errType) {
            matchedRef = hypWords[posHyp - 1] + ' ' + matchedRef
            posHyp = posHyp - 1;
            posRef = posRef - 1;
            continue;
        }

        // Update error.
        ++werInfo[errType];

        // Adjust position of ref and hyp.
        if ('del' === errType) {
            --posRef;
        } else if ('ins' === errType) {
            --posHyp;
        } else {
            // errType == 'sub'
            --posHyp;
            --posRef;
        }
    }

    // Verify the computation of edit distance finishes
    if (distmat[distmat.length - 1][distmat[0].length - 1] !== werInfo['ins'] + werInfo['del'] + werInfo['sub']) {
        console.log('WER calculation mistake!');
    }

    const {summary, details} = getSummaries(werInfo);

    res.send({summary, details, html: alignedHtml});
});

// Generate strings to summarize word errors and key phrase errors.
// Returns:
//     str_sum: string summarizing total error, total word and WER.
//     str_details: string breaking down three error types: del, ins, sub.
const getSummaries = function(werInfo) {
    const nRef = werInfo['nw'];
    const totalError = werInfo['ins'] + werInfo['del'] + werInfo['sub'];
    const strSum = `total WER = ${totalError}, total word = ${nRef}, wer = ${getWER(werInfo).toFixed(2)}`;

    const strDetails = `Error breakdown: del = ${(werInfo['del'] * 100.0 / nRef).toFixed(2)}, 
                            ins = ${(werInfo['ins'] * 100.0 / nRef).toFixed(2)}, 
                            sub = ${(werInfo['sub'] * 100.0 / nRef).toFixed(2)}`;

    return {summary: strSum, details: strDetails};
};

// Compute Word Error Rate (WER).
// Note: WER can be larger than 100.0, esp when there are many insertion errors.
// Returns:
//     WER as percentage number, usually between 0.0 to 100.0
const getWER = function(werInfo) {
    const nRef = Math.max(1, werInfo['nw']) // non_zero value for division
    const totalError = werInfo['ins'] + werInfo['del'] + werInfo['sub'];

    return totalError * 100.0 / nRef;
};

// Generate a html element to highlight the difference between hyp and ref.
// Args:
//     hyp: Hypothesis string.
//     ref: Reference string.
//     errType: one of 'none', 'sub', 'del', 'ins'.
//     Returns:
// a html string where disagreements are highlighted.
//     Note `hyp` is highlighted in green, and marked with <del> </del>
//     `ref` is highlighted in yellow. If you want html with nother styles,
//     consider to write your own function.
// Raises:
//     ValueError: if errType is not among ['none', 'sub', 'del', 'ins'].
//     or if when errType == 'none', hyp != ref
const highlightAlignedHtml = function(hyp, ref, errType) {
    let highlighted_html = '';

    if ('none' === errType) {
        if (hyp !== ref) {
            throw new Error(`hyp (${hyp}) does not match ref (${ref}) for none error`);
        }

        highlighted_html += `${hyp} `;
    } else if ('sub' === errType) {
        highlighted_html += `
            <span style="background-color: yellow">
                <del>${hyp}</del>
            </span>
            <span style="background-color: yellow">
                ${ref} 
            </span>
        `;
    } else if ('del' === errType) {
        highlighted_html += `
            <span style="background-color: red">
                ${ref} 
            </span>
        `;
    } else if ('ins' === errType) {
        highlighted_html += `
            <span style="background-color: green">
                <del>${hyp}</del>
            </span>
        `;
    } else {
        throw new Error(`unknown err_type: ${errType}`);
    }

    return highlighted_html;
};

// Compute edit distance between two list of strings.
// Args:
//     hyp_words: the list of words in the hypothesis sentence
//     ref_words: the list of words in the reference sentence
// Returns:
//     Edit distance matrix (in the format of list of lists), where the first
//     index is the reference and the second index is the hypothesis.
const computeEditDistanceMatrix = function(hypWords, refWords) {
    const rows = refWords.length;
    const cols = hypWords.length;
    const editDistMat = Array(1 + rows).fill([]).map(_ => Array(1 + cols).fill(0));

    editDistMat[0] = [...Array(1 + cols).keys()];

    for (let j = 1; rows >= j; ++j) {
        editDistMat[j][0] = j;
    }

    // Do dynamic programming.
    for (let i = 1; rows >= i; ++i) {
        for (let j = 1; cols >= j; ++j) {
            if (refWords[i - 1] === hypWords[j - 1]) {
                editDistMat[i][j] = editDistMat[i - 1][j - 1];
            } else {
                const replaceChar = 1 + editDistMat[i - 1][j - 1];
                const insertChar = 1 + editDistMat[i][j - 1];
                const deleteChar = 1 + editDistMat[i - 1][j];
                editDistMat[i][j] = Math.min(replaceChar, insertChar, deleteChar);
            }
        }
    }

    return editDistMat;
};

// Preprocess text before WER calculation.
const txtPreprocess = function(txt) {
    // Remove comments surrounded by box brackets, such as [comments]:
    txt = txt.replace(/ *\[[^\]]*]/, '');

    // Lowercase, remove \t and new line.
    txt = txt.toLowerCase().replace(/[\t\n]/, ' ');

    // Remove punctuation before space.
    txt = txt.replace(/[,.\?!]+ /, ' ');

    // Remove punctuation before end.
    txt = txt.replace(/[,.\?!]+$/, ' ');

    // Remove punctuation after space.
    txt = txt.replace(/ [,.\?!]+/, ' ');

    // Remove quotes, [, ], ( and ).
    txt = txt.replace(/["\(\)\[\]]/, '');

    // Remove extra space.
    txt = txt.trim().replace(' +', ' ');

    return txt;
};

app.post('/transcription', type, async (req, res) => {
    // const filename = 'Local path to audio file, e.g. /path/to/audio.raw';
    // const encoding = 'Encoding of the audio file, e.g. LINEAR16';
    // const sampleRateHertz = 16000;
    // const languageCode = 'BCP-47 language code, e.g. en-US';
    const config = {
        encoding: 'WAV',
        sampleRateHertz: 48000,
        languageCode: 'en-US',
    };

    /**
     * Note that transcription is limited to 60 seconds audio.
     * Use a GCS file for audio longer than 1 minute.
     */
    const audio = {
        content: Buffer.from(req.file.buffer).toString('base64'),
    };

    const request = {
        config: config,
        audio: audio,
    };

    try {
        // Detects speech in the audio file. This creates a recognition job that you
        // can wait for now, or get its result later.
        const [operation] = await client.longRunningRecognize(request);

        // Get a Promise representation of the final result of the job
        const [response] = await operation.promise();
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');

        res.send({data: transcription});
    } catch (e) {
        console.error(e);
        res.status(500);
    }
});

app.listen(5000, err => {
    console.log('Listening');
});
