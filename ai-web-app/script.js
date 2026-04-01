// Globals
let isModelLoaded = false;
let isInterviewActive = false;
let detectionInterval;
let interviewTimeline = []; // store objects: { time, emotion, confidence }
let multipleFacesStartTime = null;
let faceCountHistory = [];

let selectedRole = "";
let selectedDifficulty = "";

let interviewData = [];
let lastQuestion = "";
let isAITalking = false;
const MAX_QUESTIONS = 5;

// Load persisted data on boot
function loadData() {
  const stored = localStorage.getItem('interviewData');
  if (stored) {
    try {
      interviewData = JSON.parse(stored);
      document.getElementById('show-report-btn').classList.remove('hidden');
    } catch(e) { console.error("Error loading localStorage data", e); }
  }
}

function saveQA(question, answer, score, feedback) {
  if (!question || !answer) return;
  interviewData.push({ question, answer, score, feedback });
  
  // Persist to local storage
  localStorage.setItem('interviewData', JSON.stringify(interviewData));
  
  // Update UI Tracker
  const currentQ = interviewData.length + 1;
  document.getElementById("q-current").innerText = currentQ <= MAX_QUESTIONS ? currentQ : MAX_QUESTIONS;
  
  // Auto-Terminate Threshold
  if (interviewData.length >= MAX_QUESTIONS) {
    speakAI("We have completed all questions. I am formally ending the interview now.");
    endInterview(false);
  }
}

// Voice API Globals
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let synth = window.speechSynthesis;
let silenceTimer = null;
let isRecording = false;

// DOM Elements
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const statusText = document.getElementById("cam-status");
const startBtn = document.getElementById("start-interview-btn");
const endBtn = document.getElementById("end-interview-btn");
const speakBtn = document.getElementById("speak-btn");

const facesText = document.getElementById("faces-text");
const emotionText = document.getElementById("emotion-text");
const confidenceText = document.getElementById("confidence-text");
const warningBanner = document.getElementById("warning-banner");

// Initialize Configs
function handleDomainChange() {
  const domainSelect = document.getElementById("domain");
  const customRoleInput = document.getElementById("custom-role");
  if (domainSelect.value === "Other") {
    customRoleInput.classList.remove("hidden");
  } else {
    customRoleInput.classList.add("hidden");
  }
  validateSetup();
}

function validateSetup() {
  const domainSelect = document.getElementById("domain");
  const customRoleInput = document.getElementById("custom-role");
  const difficultySelect = document.getElementById("difficulty");
  const startBtn = document.getElementById("start-interview-btn");

  let isValid = true;
  if (!domainSelect.value) isValid = false;
  if (domainSelect.value === "Other" && !customRoleInput.value.trim()) isValid = false;
  if (!difficultySelect.value) isValid = false;

  startBtn.disabled = !isValid || !isModelLoaded;
}

async function loadModels() {
  statusText.innerText = "Loading Models...";
  const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
    isModelLoaded = true;
    console.log("Models Loaded");
    statusText.innerText = "Ready to start interview.";
    validateSetup();
  } catch (e) {
    console.error("Model Error:", e);
    statusText.innerText = "Error loading models.";
  }
}

function initSpeech() {
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    
    recognition.onresult = (event) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        finalTranscript += event.results[i][0].transcript;
      }
      document.getElementById("prompt").value = finalTranscript;
    };

    recognition.onstart = () => {
      isRecording = true;
      document.getElementById("prompt").disabled = false;
      toggleVoiceUI(true);
    };

    recognition.onend = () => {
      isRecording = false;
      toggleVoiceUI(false);
      document.getElementById("prompt").disabled = true;
      
      const text = document.getElementById("prompt").value.trim();
      if (text && isInterviewActive) {
        generateResponse();
      }
    };
  } else {
    console.warn("Speech Recognition API not supported in this browser.");
  }
  
  // preload voices
  if (synth) synth.getVoices();
}

// Call on load
loadModels();
initSpeech();
loadData();

function mapEmotionToConfidence(emotion) {
  if (['happy', 'neutral'].includes(emotion)) return "Confident 😎";
  if (['fear', 'sad'].includes(emotion)) return "Nervous 😰";
  if (emotion === 'angry') return "Stressed 😠";
  return "Uncertain 🤔";
}

async function startInterview() {
  if (!isModelLoaded) return;

  const domainSelect = document.getElementById("domain");
  const customRoleInput = document.getElementById("custom-role");
  const difficultySelect = document.getElementById("difficulty");

  selectedRole = domainSelect.value === "Other" ? customRoleInput.value.trim() : domainSelect.value;
  selectedDifficulty = difficultySelect.value;

  document.getElementById("display-role").innerText = selectedRole;
  document.getElementById("display-difficulty").innerText = selectedDifficulty;
  document.getElementById("interview-context").classList.remove("hidden");

  domainSelect.disabled = true;
  customRoleInput.disabled = true;
  difficultySelect.disabled = true;

  isInterviewActive = true;
  interviewTimeline = [];
  interviewData = [];
  localStorage.removeItem('interviewData'); // reset session map
  lastQuestion = "";
  multipleFacesStartTime = null;
  warningBanner.classList.add("hidden");
  document.getElementById("feedback-card").classList.add("hidden");
  document.getElementById("q-tracker").classList.remove("hidden");
  document.getElementById("q-current").innerText = "1";
  document.getElementById("show-report-btn").classList.add("hidden");
  document.getElementById("debug-panel").classList.remove("hidden");
  faceCountHistory = [];
  
  startBtn.disabled = true;
  endBtn.disabled = false;
  speakBtn.disabled = false;
  statusText.innerText = "Interview in progress...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { width: 640, height: 480, facingMode: "user" }, 
      audio: true 
    });
    video.srcObject = stream;
    
    // Auto initiate first AI question
    document.getElementById("prompt").value = "Hello, I am ready to start my interview.";
    generateResponse();
    
  } catch (err) {
    statusText.innerText = "Webcam/Mic access denied.";
    console.error(err);
    endInterview();
  }
}

let animationFrameId;

video.addEventListener("play", () => {
  if (!isInterviewActive) return;

  const displaySize = { width: video.videoWidth || 640, height: video.videoHeight || 480 };
  faceapi.matchDimensions(canvas, displaySize);
  console.log("Video Ready");
  
  async function detectLoop() {
    if (!isInterviewActive) return;
    
    // Strict buffer pause
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      animationFrameId = requestAnimationFrame(detectLoop);
      return;
    }

    try {
      const detections = await faceapi.detectAllFaces(
        video, 
        new faceapi.SsdMobilenetv1Options()
      ).withFaceExpressions();

      // Ensure fresh canvas for Testing Mode draw
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (detections && detections.length > 0) {
        const rawCount = detections.length;
        
        // Draw the visual debugging geometries over the stream!
        const resizedDetections = faceapi.resizeResults(detections, displaySize);
        faceapi.draw.drawDetections(canvas, resizedDetections);
        
        // Debug UI Output
        document.getElementById("debug-raw").innerText = rawCount;
        document.getElementById("debug-filtered").innerText = rawCount;
        if (facesText) facesText.innerText = rawCount;

        // Mathematical Majority Anti-Cheating (3 out of 5 frames must be > 1)
        faceCountHistory.push(rawCount);
        if (faceCountHistory.length > 5) faceCountHistory.shift();
        
        const multipleFaceInstances = faceCountHistory.filter(c => c > 1).length;
        const isCurrentlyCheating = multipleFaceInstances >= 3;

        if (isCurrentlyCheating) {
          if (!multipleFacesStartTime) multipleFacesStartTime = Date.now();
          warningBanner.classList.remove("hidden");
          
          if (Date.now() - multipleFacesStartTime > 5000) {
            endInterview(true);
            return;
          }
        } else {
          multipleFacesStartTime = null;
          warningBanner.classList.add("hidden");
        }

        // Only log Emotion data from the highest confidence face
        const sortedFaces = detections.sort((a, b) => b.detection.score - a.detection.score);
        const primaryFace = sortedFaces[0];
        
        document.getElementById("debug-conf").innerText = primaryFace.detection.score.toFixed(2);

        const expressions = primaryFace.expressions;
        const dominantEmotion = Object.keys(expressions).reduce((a, b) => expressions[a] > expressions[b] ? a : b);
        const confidenceLevel = mapEmotionToConfidence(dominantEmotion);

        emotionText.innerText = dominantEmotion;
        confidenceText.innerText = confidenceLevel;

        // Clear low-light warning if it was active
        if (statusText.innerText === "No face detected" || statusText.innerText === "Improve lighting for better detection.") {
           statusText.innerText = "Interview in progress...";
        }

        interviewTimeline.push({
          time: new Date(),
          emotion: dominantEmotion,
          confidence: confidenceLevel
        });
      } else {
        console.log("Debug: 0 detections");
        emotionText.innerText = "No face detected";
        confidenceText.innerText = "--";
        if (facesText) facesText.innerText = "0";
        document.getElementById("debug-raw").innerText = "0";
        document.getElementById("debug-conf").innerText = "0.00";
        statusText.innerText = "No face detected";
      }
    } catch (e) {
      console.error("AI Loop Exception:", e);
    }
    
    // Automatically recurse
    animationFrameId = requestAnimationFrame(detectLoop);
  }
  
  detectLoop();
});

/* -----------------------------------------------------
   VOICE RECORDING STT MACROS
------------------------------------------------------ */
function startRecording() {
  if (!recognition || !isInterviewActive || isAITalking) return;
  document.getElementById("prompt").value = "";
  clearTimeout(silenceTimer);
  
  if (synth.speaking) {
    synth.cancel(); // Interrupt AI if speaking
    isAITalking = false;
  }
  recognition.start();
}

function stopRecording() {
  if (!recognition) return;
  recognition.stop(); // This triggers onend which auto-triggers generateResponse
}

function toggleVoiceUI(recording) {
  const speakLayer = document.getElementById("speak-btn");
  const stopLayer = document.getElementById("stop-btn");
  const indicator = document.getElementById("listening-indicator");
  
  if (recording) {
    speakLayer.classList.add("hidden");
    stopLayer.classList.remove("hidden");
    indicator.classList.remove("hidden");
  } else {
    speakLayer.classList.remove("hidden");
    stopLayer.classList.add("hidden");
    indicator.classList.add("hidden");
  }
}

/* -----------------------------------------------------
   SMART TTS LOGIC
------------------------------------------------------ */
function speakAI(text) {
  if (!synth) return;
  
  const cleanText = text.replace(/[*_#`]/g, ''); // strip markdown
  const utterance = new SpeechSynthesisUtterance(cleanText);
  
  const voices = synth.getVoices();
  const proVoice = voices.find(v => v.lang.includes('en-') && (v.name.includes('Google') || v.name.includes('Microsoft'))) || voices[0];
  if (proVoice) utterance.voice = proVoice;
  
  utterance.onstart = () => {
    isAITalking = true;
    document.getElementById("speak-btn").disabled = true;
    document.getElementById("ai-speaking-indicator").classList.add("pulse-dot");
    const aiText = document.getElementById("ai-speaking-text");
    if (aiText) aiText.innerText = "AI Speaking...";
  };
  
  utterance.onend = () => {
    isAITalking = false;
    document.getElementById("speak-btn").disabled = false;
    document.getElementById("ai-speaking-indicator").classList.remove("pulse-dot");
    const aiText = document.getElementById("ai-speaking-text");
    if (aiText) aiText.innerText = "Current AI Question";
    
    resetSilenceTimer();
    
    // Automatically start listening for answer once AI finishes speaking
    if (isInterviewActive && lastQuestion !== "") {
       setTimeout(() => { startRecording(); }, 500);
    }
  };
  
  synth.speak(utterance);
}

function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  if (!isInterviewActive) return;
  
  // If 15 seconds pass securely without recording, prompt user
  silenceTimer = setTimeout(() => {
    if (!isRecording && isInterviewActive) {
      speakAI("Are you still there? Please trigger the microphone to speak your answer.");
    }
  }, 15000); 
}

/* -----------------------------------------------------
   INTERVIEW MANAGEMENT
------------------------------------------------------ */
function endInterview(isTerminated = false) {
  isInterviewActive = false;
  validateSetup(); // re-evaluates and enables startBtn if options are selected
  endBtn.disabled = true;
  speakBtn.disabled = true;
  statusText.innerText = isTerminated ? "Terminated (Cheating)" : "Interview Finished. Generating Report...";

  document.getElementById("domain").disabled = false;
  document.getElementById("custom-role").disabled = false;
  document.getElementById("difficulty").disabled = false;

  document.getElementById("q-tracker").classList.add("hidden");
  document.getElementById("show-report-btn").classList.remove("hidden");

  clearTimeout(silenceTimer);
  if (synth.speaking) synth.cancel();
  if (recognition && isRecording) recognition.stop();

  cancelAnimationFrame(animationFrameId);
  if (detectionInterval) clearInterval(detectionInterval);
  emotionText.innerText = "--";
  confidenceText.innerText = "--";
  if (facesText) facesText.innerText = "0";
  warningBanner.classList.add("hidden");
  document.getElementById("debug-panel").classList.add("hidden");

  // Stop camera + mic cleanly
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  
  if (isTerminated === true) {
    generateCheatingReport();
  } else if (interviewData.length > 0) {
    generateFinalReport();
  } else {
    statusText.innerText = "Interview Finished (No Data).";
  }
}

function generateCheatingReport() {
  const modal = document.getElementById("report-modal");
  const reportBody = document.getElementById("report-details");
  
  reportBody.innerHTML = `
    <h3 style="color: var(--danger); margin-bottom: 10px; font-size: 1.5rem;">Status: Terminated due to cheating</h3>
    <p style="font-size: 1.1rem; margin-bottom: 15px;"><strong>Reason:</strong> Multiple faces detected during interview.</p>
    <p style="color: var(--text-muted);">Following our strict proctoring guidelines, your session has been permanently closed.</p>
  `;
  modal.classList.remove("hidden");
}

async function generateFinalReport() {
  const modal = document.getElementById("report-modal");
  const reportBody = document.getElementById("report-details");

  reportBody.innerHTML = "<p>Connecting to AI evaluator to generate your comprehensive performance report...</p><div class='loading'></div>";
  modal.classList.remove("hidden");

  // Calculate Emotion Confidence breakdown natively
  const counts = { Confident: 0, Nervous: 0, Stressed: 0, Uncertain: 0 };
  interviewTimeline.forEach(d => {
    if (d.confidence.includes("Confident")) counts.Confident++;
    if (d.confidence.includes("Nervous")) counts.Nervous++;
    if (d.confidence.includes("Stressed")) counts.Stressed++;
    if (d.confidence.includes("Uncertain")) counts.Uncertain++;
  });
  const total = interviewTimeline.length || 1;
  const firstHalf = interviewTimeline.slice(0, Math.floor(total/2));
  const secondHalf = interviewTimeline.slice(Math.floor(total/2));
  
  let earlyNervous = firstHalf.filter(d => d.confidence.includes("Nervous")).length;
  let lateConfident = secondHalf.filter(d => d.confidence.includes("Confident")).length;
  
  let psychologicalTrend = "Maintained a consistent emotional state.";
  if (earlyNervous > lateConfident && earlyNervous > 0) psychologicalTrend = "Candidate started nervous and struggled to fully recover composure.";
  if (lateConfident > earlyNervous && lateConfident > 0) psychologicalTrend = "Candidate started nervous, but displayed excellent recovery and gained strong confidence over time!";
  if (counts.Confident / total > 0.8) psychologicalTrend = "Candidate remained highly confident and composed throughout the entire session.";

  const API_KEY = "AIzaSyBRq0QSZKzxU9e91Ic1EMU_idKuWmaC5f8";
  
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: `You are a Senior Technical Recruiter.\nAnalyze the provided raw JSON array containing a candidate's full interview history (Questions answered, their raw answers, and the system score).\nTake into account their Psychological profile during the interview: "${psychologicalTrend}".\n\nYou MUST return a JSON object exactly matching this schema:\n{\n  "overall_score": 85,\n  "strengths": ["string"],\n  "weaknesses": ["string"],\n  "communication_feedback": "string",\n  "technical_knowledge_feedback": "string",\n  "improvement_roadmap": "string"\n}`
            }]
          },
          generationConfig: { responseMimeType: "application/json" },
          contents: [{ parts: [{ text: JSON.stringify(interviewData) }] }],
        }),
      }
    );

    const data = await response.json();
    if (data.candidates && data.candidates.length > 0) {
      const rawText = data.candidates[0].content.parts[0].text;
      const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
      const report = JSON.parse(cleanJson);
      
      const questionHistoryCards = interviewData.map((data, index) => `
        <div class="report-card">
          <h4>Question ${index + 1}: ${data.question}</h4>
          <p><strong>Your Answer:</strong> ${data.answer}</p>
          <p style="color:#60a5fa;"><strong>Feedback:</strong> ${data.feedback}</p>
          <span id="eval-pill">Score: ${data.score}/10</span>
        </div>
      `).join('');

      // Add a slight delay to allow rendering before firing CSS width animation
      setTimeout(() => {
        const fillBar = document.getElementById('final-score-fill');
        if (fillBar) fillBar.style.width = report.overall_score + "%";
      }, 300);

      reportBody.innerHTML = `
        <div style="display: grid; gap: 20px; grid-template-columns: 1fr 1fr; text-align: left; margin-bottom: 30px;">
          <div style="background: rgba(16,185,129,0.1); padding: 15px; border-radius: 8px; border: 1px solid rgba(16,185,129,0.3);">
            <h3 style="color:#10b981; margin-bottom:10px;">Overall Target Score</h3>
            <h1 style="font-size: 2.5rem; color:#fff; margin-bottom: -5px;">${report.overall_score}<span style="font-size:1.2rem; color:var(--text-muted)">/100</span></h1>
            <div class="score-bar">
              <div id="final-score-fill" class="score-fill" style="width: 0%;"></div>
            </div>
            <p style="margin-top:20px;"><strong>Technical Feedback:</strong> ${report.technical_knowledge_feedback}</p>
            <p style="margin-top:10px;"><strong>Communication:</strong> ${report.communication_feedback}</p>
          </div>
          
          <div style="background: rgba(59,130,246,0.1); padding: 15px; border-radius: 8px; border: 1px solid rgba(59,130,246,0.3);">
            <h3 style="color:#60a5fa; margin-bottom:10px;">Psychological Analytics</h3>
            <p style="color:#93c5fd; margin-bottom:15px;"><em>"${psychologicalTrend}"</em></p>
            <ul style="list-style:none; padding:0;">
              <li>Confident 😎: ${Math.round((counts.Confident/total)*100)}%</li>
              <li>Nervous 😰: ${Math.round((counts.Nervous/total)*100)}%</li>
              <li>Stressed 😠: ${Math.round((counts.Stressed/total)*100)}%</li>
            </ul>
          </div>
        </div>

        <div style="display: grid; gap: 20px; grid-template-columns: 1fr 1fr; text-align: left; margin-bottom: 30px;">
          <div>
            <h4 style="color:#facc15;">Key Strengths</h4>
            <ul style="color:var(--text-muted); padding-left:20px; margin-bottom: 10px;">
              ${report.strengths.map(s => `<li>${s}</li>`).join('')}
            </ul>
          </div>

          <div>
            <h4 style="color:#f87171;">Areas for Improvement</h4>
            <ul style="color:var(--text-muted); padding-left:20px; margin-bottom: 10px;">
              ${report.weaknesses.map(w => `<li>${w}</li>`).join('')}
            </ul>
          </div>
        </div>
        
        <div style="text-align: left; margin-bottom: 30px;">
          <h4 style="color:#a78bfa;">Improvement Roadmap</h4>
          <p style="color:var(--text-muted);">${report.improvement_roadmap}</p>
        </div>

        <h3 style="color:#fff; text-align:left; margin-bottom: 15px; padding-top:20px; border-top: 1px solid rgba(255,255,255,0.1);">Question Breakdown</h3>
        ${questionHistoryCards}
      `;
      statusText.innerText = "Interview Summarized.";
    }
  } catch (error) {
    console.error(error);
    reportBody.innerHTML = `<p style="color:var(--danger)">Error generating AI Report: ${error.message}</p>`;
  }
}

function showReportModal() {
  const modal = document.getElementById("report-modal");
  const reportBody = document.getElementById("report-details");
  if (!reportBody.innerHTML.includes("Overall Technical Score")) {
    if (interviewData && interviewData.length > 0) {
      generateFinalReport(); // trigger generation if reloaded from local storage
    } else {
       reportBody.innerHTML = `<p>No interview data to map.</p>`;
       modal.classList.remove("hidden");
    }
  } else {
    modal.classList.remove("hidden");
  }
}

function closeModal() {
  document.getElementById("report-modal").classList.add("hidden");
}

/* Original AI Generative Logic Integration */
async function generateResponse() {
  if (!isInterviewActive && !startBtn.disabled) return alert("Please Start the Interview first.");
  if (statusText.innerText.includes("Terminated")) return alert("This interview has been terminated.");

  clearTimeout(silenceTimer); // disable silence checks while formulating
  const promptElement = document.getElementById("prompt");
  const outputElement = document.getElementById("output");
  const button = document.getElementById("generate-btn");
  
  let prompt = promptElement.value.trim();

  if (!prompt) return;

  const API_KEY = "AIzaSyBRq0QSZKzxU9e91Ic1EMU_idKuWmaC5f8";

  const originalBtnText = button.innerHTML;
  button.innerHTML = '<span>Generating AI Audio...</span> <span class="loading"></span>';
  button.disabled = true;
  button.style.opacity = '0.7';
  outputElement.innerHTML = '';

  let conversationContextText = interviewData.map((data, index) => 
    `Interviewer: ${data.question}\nCandidate: ${data.answer}`
  ).join("\n\n");
  
  let fullPrompt = `Previous Conversation Transcript:\n${conversationContextText ? conversationContextText : "None. This is the beginning of the interview."}\n\nCandidate's latest input: "${prompt}"\n\nPlease evaluate the input (if it's an answer) and generate the next interview question.`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: `You are a professional technical interviewer.\nYour job is to conduct a real interview based on the candidate's selected role/domain: ${selectedRole}.\nThe difficulty level requested is: ${selectedDifficulty}.\n\nInstructions:\n- If difficulty is Beginner, ask fundamental and simple conceptual questions.\n- If difficulty is Intermediate, mix concepts with practical questions.\n- If difficulty is Professional, ask advanced, real-world scenario-based questions, including problem-solving and system design.\n- Evaluate the user's answer to the previous question out of 10.\n- You MUST return a strictly formatted JSON object exactly matching this schema: { "score": 8, "feedback": "Brief feedback text", "improvement": "Brief improvement suggestion", "next_question": "The next conversational interview question text" }.\n- If this is the very first contact and the user is just saying hello, score and feedback can be null, just provide the next_question.\n- Do NOT return markdown code blocks, just raw JSON.`
            }]
          },
          generationConfig: {
            responseMimeType: "application/json",
          },
          contents: [{ parts: [{ text: fullPrompt }] }],
        }),
      }
    );

    const data = await response.json();
    let output = "";
    if (data.candidates && data.candidates.length > 0) {
      const rawText = data.candidates[0].content.parts[0].text;
      
      try {
        const cleanJsonString = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
        const evalData = JSON.parse(cleanJsonString);
        
        // Save history
        if (lastQuestion && prompt && prompt !== "Hello, I am ready to start my interview.") {
          saveQA(lastQuestion, prompt, evalData.score, evalData.feedback);
        }
        
        // Update Feedback UI
        document.getElementById("feedback-card").classList.remove("hidden");
        document.getElementById("eval-score").innerText = evalData.score !== null ? evalData.score : "--";
        document.getElementById("eval-feedback").innerText = evalData.feedback || "--";
        document.getElementById("eval-improvement").innerText = evalData.improvement || "--";
        
        const pill = document.getElementById("eval-pill");
        if (evalData.score >= 8) { pill.innerText = "Excellent"; pill.style.color = "#4ade80"; }
        else if (evalData.score >= 5) { pill.innerText = "Average"; pill.style.color = "#facc15"; }
        else if (evalData.score !== null) { pill.innerText = "Needs Work"; pill.style.color = "#f87171"; }
        else { pill.innerText = "Greeting"; pill.style.color = "#93c5fd"; }

        output = evalData.next_question;
        outputElement.innerText = output;
        lastQuestion = output;
        
        // TTS INJECTION (ONLY speak the next question natively, no feedback audio)
        const currentEmote = confidenceText ? confidenceText.innerText : "";
        let ttsString = output;
        
        if (currentEmote.includes("Nervous") || currentEmote.includes("Stressed")) {
          speakAI("Take your time. " + ttsString);
        } else {
          speakAI(ttsString);
        }
        
      } catch (e) {
        console.error("JSON Parse Error:", rawText);
        outputElement.innerText = "Error parsing AI response format.";
      }
      
    } else if (data.error) {
      outputElement.innerText = "Error: " + data.error.message;
    }
    
  } catch (error) {
    outputElement.innerText = "Error connecting to AI: " + error.message;
  } finally {
    button.innerHTML = originalBtnText;
    button.disabled = false;
    button.style.opacity = '1';
    promptElement.value = ""; // clear box for next input
  }
}
