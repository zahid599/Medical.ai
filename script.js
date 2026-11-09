const input = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const micBtn = document.getElementById("micBtn");
const chatMessages = document.getElementById("chatMessages");
const loading = document.getElementById("loading");
const welcome = document.getElementById("welcome");
const language = document.getElementById("language");

let history = [];
let voiceEnabled = true;

// Add chat message
function addMessage(text, type) {

    welcome.style.display = "none";

    const message = document.createElement("div");

    message.className =
        type === "user"
        ? "message user-message"
        : "message ai-message";

    message.textContent = text;

    chatMessages.appendChild(message);

    message.scrollIntoView({
        behavior: "smooth",
        block: "nearest"
    });
}

// AI voice response
function speak(text) {

    if (!voiceEnabled) return;

    if (!("speechSynthesis" in window)) return;

    speechSynthesis.cancel();

    const speech = new SpeechSynthesisUtterance(text);

    speech.lang = language.value;

    speech.rate = 1;

    speechSynthesis.speak(speech);
}

// Send message to Gemini backend
async function sendMessage(message = input.value) {

    const text = message.trim();

    if (!text) return;

    addMessage(text, "user");
    input.value = "";

    loading.classList.remove("hidden");
    sendBtn.disabled = true;

    try {

        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: text,
                history: history,
                language: language.value
            })
        });

        // Read the server response safely
        const raw = await response.text();

        if (!raw) {
            throw new Error(
                "Server returned an empty response. Check server.js."
            );
        }

        let data;

        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error(
                "Server did not return valid JSON. Check server.js and the terminal."
            );
        }

        if (!response.ok) {
            throw new Error(data.error || "AI server error");
        }

        const answer = data.reply;

        if (!answer) {
            throw new Error("AI returned an empty answer.");
        }

        addMessage(answer, "ai");

        history.push(
            { role: "user", text: text },
            { role: "model", text: answer }
        );

        if (history.length > 16) {
            history = history.slice(-16);
        }

        speak(answer);

    } catch (error) {

        addMessage(
            "Error: " + error.message,
            "ai"
        );

        console.error(error);

    } finally {

        loading.classList.add("hidden");
        sendBtn.disabled = false;

    }
}

// Send button
sendBtn.addEventListener("click", () => {
    sendMessage();
});

// Enter key
input.addEventListener("keydown", function(event) {

    if (event.key === "Enter" && !event.shiftKey) {

        event.preventDefault();

        sendMessage();

    }

});

// Symptom buttons
document.querySelectorAll("[data-message]").forEach(button => {

    button.addEventListener("click", () => {

        sendMessage(button.dataset.message);

    });

});

// New chat
document.getElementById("newChat").addEventListener("click", () => {

    history = [];

    chatMessages.innerHTML = "";

    welcome.style.display = "block";

    speechSynthesis.cancel();

});

// Voice output on/off
document.getElementById("voiceToggle").addEventListener("click", function() {

    voiceEnabled = !voiceEnabled;

    this.textContent = voiceEnabled ? "🔊" : "🔇";

    if (!voiceEnabled) {
        speechSynthesis.cancel();
    }

});

// Voice input
const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

if (SpeechRecognition) {

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;

    let listening = false;

    micBtn.addEventListener("click", () => {

        if (listening) {
            recognition.stop();
            return;
        }

        recognition.lang = language.value;

        try {
            recognition.start();
        } catch (error) {
            console.error("Could not start mic:", error);
        }

    });

    recognition.onstart = () => {
        listening = true;
        micBtn.classList.add("listening");
        micBtn.textContent = "⏺";
    };

    recognition.onend = () => {
        listening = false;
        micBtn.classList.remove("listening");
        micBtn.textContent = "🎙️";
    };

    recognition.onresult = (event) => {
        input.value = event.results[0][0].transcript;
        sendMessage();
    };

    recognition.onerror = (event) => {

        console.error("Speech error:", event.error);

        const messages = {
            "not-allowed": "Microphone is blocked. Click the lock icon in the address bar, allow the microphone, and reload the page.",
            "service-not-allowed": "Speech recognition is blocked in this browser. Please use Chrome or Edge at http://localhost:3000.",
            "audio-capture": "No microphone was found. Check that one is connected and enabled in Windows settings.",
            "no-speech": "I didn't hear anything. Please try again and speak after the mic icon changes.",
            "network": "Speech recognition could not reach the internet speech service. Check your connection, VPN or antivirus.",
            "language-not-supported": "This language is not supported for voice input in your browser."
        };

        addMessage(
            messages[event.error] || ("Microphone error: " + event.error),
            "ai"
        );

    };

} else {

    micBtn.addEventListener("click", () => {
        addMessage(
            "Voice recognition is not supported in this browser. Please use Chrome or Edge.",
            "ai"
        );
    });

}

// Find nearby hospitals
document.getElementById("hospitalBtn").addEventListener("click", () => {

    if (!navigator.geolocation) {

        alert("Location is not supported by your browser.");

        return;

    }

    navigator.geolocation.getCurrentPosition(

        (position) => {

            const latitude = position.coords.latitude;

            const longitude = position.coords.longitude;

            const mapURL =
                `https://www.google.com/maps/search/hospitals/@${latitude},${longitude},14z`;

            window.open(mapURL, "_blank");

        },

        () => {

            alert(
                "Location permission denied. Please allow location access and try again."
            );

        }

    );

});