const UserName = localStorage["UserName"];
const UserRoom = localStorage["UserRoom"];

const chatMessageText = document.getElementById("chatMessageText");
const chatMessages = document.getElementById("chatMessages");
const startGameButton = document.getElementById("startGameButton");
startGameButton.innerHTML = "Ready"; //reset just in case they disconnected but didn't reload the html somehow
const readyPlayersDisplay = document.getElementById("readyPlayersDisplay");
const KNIGHT_DESC = document.getElementById("knightDesc");
const KNAVE_DESC = document.getElementById("knaveDesc");
const attackPowerDisplay = document.getElementById("attackPowerDisplay");
const votingButtons = document.getElementById("votingButtons");

const playerCard = document.getElementById("playerCard");
const attackCard0 = document.getElementById("attackCard0");
const attackCard1 = document.getElementById("attackCard1");

const numberCardsInHandDisplay = 3;
const numberCardsInPlayDisplay = 4;
var currentRound = 0;
var numAssassinations = 0;

const playedCards = [];
for(var i = 0; i < numberCardsInPlayDisplay; i++) {
    playedCards.push(document.getElementById("playedCard_" + i));
}

const cardsInHand = [];
for(var i = 0; i < numberCardsInHandDisplay; i++) {
    cardsInHand.push(document.getElementById("cardInHand_" + i));
}

class PlayingCard {
    constructor(card, cardToReplace) {
        this.suit = card.suit;
        this.value = card.value;

        this.htmlObject = cardToReplace;

        if(this.suit.includes("Joker")) this.htmlObject.src = "card-images/" + this.value + ".png"
        else this.htmlObject.src = "card-images/" + this.suit[0] + "_" + this.value + ".png";
    }
}

var playerNames = [];
const socket = io();

socket.on("UpdatePlayers", (newPlayers) => {
    if(!playerNames) {
        createChatMessage("server", "Game Room Found!", true);
    }
    const oldNames = playerNames;
    playerNames = [];
    for(const name of oldNames) {
        if(!newPlayers.includes(name)) createChatMessage("server", name + " left the game.", true);
    }
    
    for(const name of newPlayers) {
        if(!oldNames.includes(name)) createChatMessage("server", name + " joined the game.", true);
        playerNames.push(name);
    }
});

socket.on("Message_Recieve", (user, text) => {
    createChatMessage(user, text, false);
});

socket.on("NumberOfReadyPlayers", (numP) => {
    readyPlayersDisplay.innerHTML = "Players Ready:<br>" + numP + "/" + playerNames.length;
});

socket.on("GameStart", (roleCard) => {
    new PlayingCard(roleCard, playerCard);
    startGameButton.remove();
    readyPlayersDisplay.remove();
    if(roleCard.suit.includes("Joker")) {
        KNIGHT_DESC.style.display = "none";
        KNAVE_DESC.style.display = "block";
    } else {
        KNAVE_DESC.style.display = "none";
        KNIGHT_DESC.style.display = "block";
    }
});

socket.on("RoundStart", (attackers) => {
    new PlayingCard(attackers[0], attackCard0);
    new PlayingCard(attackers[1], attackCard1);
    
    const attackPower = 3*attackers[0].value + attackers[1].value;
    attackPowerDisplay.innerHTML = "Attack Power: " + attackPower + "<br>Needed Suit: " + attackers[1].suit;

    for(const card of playedCards) {
        card.src = "card-images/card_back.png";
    }
    for(const card of cardsInHand) {
        card.src = "card-images/card_back.png";
    }
});

socket.on("RoundEnd", (didDefend, playedCards) => {
    for(const card of playedCards) {
        createChatMessage("server", "The " + card.value + " of " + card.suit + " was played.", true);
    }

    currentRound += 1;
    if(didDefend) createChatMessage("server", "The Knights successfully defeated the attackers!", true);
    else {
        createChatMessage("server", "The Knights failed to defeat the attackers, a royal has been assassinated.", true);
        numAssassinations += 1;
    }
    
    const numKings = Math.max(4 - currentRound, 0);
    const numQueens = Math.min(8 - currentRound, 4);
    createChatMessage("server", "There are " + numKings + " kings still under attack.", true);
    createChatMessage("server", "There are " + numQueens + " queens still under attack.", true);
    createChatMessage("server", numAssassinations + " royals have been assassinated.", true);
});

socket.on("TurnIsOccurring", (pNum) => {
    createChatMessage("server", playerNames[pNum] + " is taking their turn.", true);
});

socket.on("TakeTurn", (hand, cardsPlayed) => {
    new PlayingCard(hand[0], cardsInHand[0]);
    new PlayingCard(hand[1], cardsInHand[1]);
    new PlayingCard(hand[2], cardsInHand[2]);

    for(var i = 0; i < cardsPlayed.length; i++) {
        new PlayingCard(cardsPlayed[i], playedCards[i]);
    }
    for(const card of playedCards) {
        card.style.display = "block";
    }
});

socket.on("endGame", (numA) => {
    if(numA < 3) {
        createChatMessage("server", "The Knights have won the game.", true);
        createChatMessage("server", "This room will close shortly.", true);
    }
    else if(numA > 3) {
        createChatMessage("server", "The Knave has won the game.", true);
        createChatMessage("server", "This room will close shortly.", true);
    }
    else {
        createChatMessage("server", "Three royals were assassinated. For the knights to win the game, they must correctly vote out the knave.", true);
        for(var i = 0; i < playedCards.length; i++) {
            playedCards[i].style.display = "none";
        }

        for(var i = 0; i < playerNames.length; i++) {
            const b = document.createElement("button");
            b.innerHTML = playerNames[i];
            b.setAttribute("onClick", "sendVote(" + i + ")");
            votingButtons.appendChild(b);
        }
    }
});

socket.on("endVoting", (knaveSlot, knaveWins) => {
    createChatMessage("server", "The Knave was " + playerNames[parseInt(knaveSlot)] + ".")
    if(knaveWins) createChatMessage("server", "The Knave won by going undetected.", true);
    else createChatMessage("server", "The Knights won by successfully voting out the Knave.", true);
    createChatMessage("server", "This room will close shortly.", true);
});

socket.emit("CheckIn", UserName, UserRoom);

function createChatMessage(user, messageText, fromServer) {
    const p = document.createElement("p");
    if(fromServer) p.className = "chatMessage_Server";
    else {
        if(user === UserName) p.className = "chatMessage_Sent";
        else p.className = "chatMessage_Recieved";
        p.innerHTML = user + ":<br>";
    }
    p.innerHTML += messageText;
    chatMessages.appendChild(p);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
    var text = chatMessageText.value;
    if(!text) return;
    chatMessageText.value = "";
    socket.emit('Message_Send', text);
}

function readyStateChange() {
    socket.emit("PlayerReadyStateChange", startGameButton.innerHTML);
    if(startGameButton.innerHTML === "Ready") startGameButton.innerHTML = "Cancel";
    else startGameButton.innerHTML = "Ready";
}

function chooseCardFromHand(card) {
    socket.emit("PlayerCardChoice", card);
    cardsInHand[card].src = "card-images/card_back.png";
}

function sendVote(slot) {
    socket.emit("Player_Vote", slot);
}
