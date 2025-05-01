//setup for express and socket.io
const express = require('express');
const app = express();

const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {pingInterval: 2000, pingTimeout: 15000});
const port = 3000;
const playersPerRoom = 5;

const SUITS = ["Clubs", "Diamonds", "Hearts", "Spades"];
const PRIMES = [2, 3, 5, 7, 11];
class PlayingCard {
    constructor(suit, value) {
        this.suit = suit;
        this.value = value;
    }
}

function SHUFFLE_ARRAY(a) {
    for(var i = a.length - 1; i > 0; i--) {
        const swapIndex = Math.floor(Math.random() * (i+1));
        [a[i], a[swapIndex]] = [a[swapIndex], a[i]]; //swaps the elements at i and swapIndex
    }
}

class Roles_Deck {
    constructor() {
        this.roles = [];
        if(playersPerRoom === 5) {
            for(const suit of SUITS) {
                this.roles.push(new PlayingCard(suit, "Jack"));
            }
            this.roles.push(new PlayingCard("Joker", "Joker"));
        } else {
            console.log(playersPerRoom + " functionality not yet programmed.");
        }
        SHUFFLE_ARRAY(this.roles);
    }
}

class Cards_Deck {
    constructor() {
        this.cards = [];
        for(const suit of SUITS) {
            for(var i = 2; i <= 11; i++) {
                this.cards.push(new PlayingCard(suit, i));
            }
        }
        SHUFFLE_ARRAY(this.cards);
    }
}

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

//removes certain characters to protect against xss
function validateInput(inp) {
    return inp.replace(/[&<>'"]/g, (m) => {
        return "&#" + m.charCodeAt(0) + ";";
    });
}

//holds a socket id as a key, with a value object that holds player data
//players[socket.id] has properties isBot, username, requestedRoom, actualRoom (if found), and roomSlot (if found).
const players = {};

//holds the players waiting to get into a given room. The user inputted room id is the key, so
//roomRequests[UserRoom] is an object with socket ids as keys, and true as values (object used over array for easier insertion/deletion)
//roomRequests[UserRoom] also has a key "successfulRooms" (which is shorter than socket ids so it will not be mistaken for one), which
//is associated with an object containing actual room values as keys, and true as values.
const roomRequests = {};

//holds all the currently active rooms, keys will be from currentRoom (0, 1, 2...), values will be objects
//Contains numPlayers, numBots, requestedRoomID, phase (integer), assassinations (integer), votes (array, only exists during vote tally),
// currentRound (integer), attackDeck (array of Card Objects), currentTurn (integer), activePlayer (integer representing slot number),
// playedCards (array of Card Objects), knaveSlot (integer), and roomSlots (object of objects specified below).
//rooms[room]["roomSlots"][slotNumber] holds info for each player: ready_status (boolean), deck (array of Card objects),
// role (card Object), id (string), and voteTally (int, only during voting).
const rooms = {};
//currentRoom ensures multiple rooms can have the same inputted room code.
var currentRoom = 0 | 0;
var globalBotID = 0 | 0; //these two have useless bitwise operations done repeatedly so they behave like 32 bit ints.

//called when a socket disconnects
function disconnectPlayer(reason, socket) {
    //get the room the dc'd player was in, if any
    var dcRoom = players[socket.id]["actualRoom"];
    if(rooms[dcRoom]) {
        rooms[dcRoom]["roomSlots"][players[socket.id]["roomSlot"]]["id"] = "_"; //Free their room slot
        rooms[dcRoom]["roomSlots"][players[socket.id]["roomSlot"]]["ready_status"] = false; //reset their ready status.
        rooms[dcRoom]["numPlayers"] -= 1; //update the player count

        if(rooms[dcRoom]["numPlayers"] - rooms[dcRoom]["numBots"] <= 0) {
            closeRoom(dcRoom)
        }
        else {
            updateRoomPlayers(dcRoom);//tell the remaining players the updated player list
        }
    }
    
    //get the room they were requesting if they dc'd while searching, and remove them from that request list
    var dcRequest = players[socket.id]["requestedRoom"];
    if(roomRequests[dcRequest]) {
        delete roomRequests[dcRequest][socket.id];
    }

    //remove them from players
    delete players[socket.id];
}

//called when a socket connects for the first time
function checkInPlayer(socket, UserName, UserRoom) {
    UserName = validateInput(UserName);
    UserRoom = validateInput(UserRoom); //sanitize username and room request
    players[socket.id]["username"] = UserName;
    players[socket.id]["requestedRoom"] = UserRoom;
    players[socket.id]["isBot"] = false;

    //If that request is new create the roomReq object
    if(!roomRequests[UserRoom]) {
        roomRequests[UserRoom] = { successfulRooms: {} };
        roomRequests[UserRoom][socket.id] = true;
        return; //the rest of the code need not be executed if only 1 player is in line
    }

    //first try to add player to existing room:
    for(const rID in roomRequests[UserRoom]["successfulRooms"]) {
        if(rooms[rID]["numPlayers"] < playersPerRoom) {
            addToRoom(socket.id, rID, true);
            return;
        }
    }

    addToWaitingList(UserRoom, socket.id);
}

//adds user to waiting list then calls checkWaitingList
function addToWaitingList(UserRoom, pId) {
    roomRequests[UserRoom][pId] = true;//add the player to the waiting list for the input room
    //then try to create a new room for the requested room id if there's enough people in line.
    checkWaitingList(UserRoom);
}

//checks if enough people are in line to create a game
function checkWaitingList(UserRoom) {
    var waitingList = [];
    for(const id in roomRequests[UserRoom]) {
        if(id == "successfulRooms") continue; //not a player id >:(
        waitingList.push(id);

        if(waitingList.length === playersPerRoom) {
            rooms[currentRoom] = {};
            rooms[currentRoom]["numPlayers"] = 0;
            rooms[currentRoom]["numBots"] = 0;
            rooms[currentRoom]["roomSlots"] = {};

            for(const user of waitingList) {
                addToRoom(user, currentRoom, false);
                delete roomRequests[UserRoom][user]; //no longer in line
            }
            //Used when deleting the room, so it can be removed from roomReqs
            rooms[currentRoom]["requestedRoomID"] = UserRoom; 
            //add the successful room to the roomRequests so more players can join if players leave
            roomRequests[UserRoom]["successfulRooms"][currentRoom] = true;

            updateRoomPlayers(currentRoom);

            currentRoom = (currentRoom + 1) | 0;
            waitingList = [];
        }
    }
}

//adds the socket with the given id to the specified room.
function addToRoom(id, room, updatePlayers) {
    room = String(room); //room int 0 and room string "0" are different in sockets.io
    if(id.length == 20) { //only for human players, not bots
        const relevantSocket = io.sockets.sockets.get(id);
        relevantSocket.join(room);
    } else rooms[room]["numBots"] += 1; //increase bot counter
    
    const pNum = rooms[room]["numPlayers"]; //note: pNum goes from 0 to PlayersPerRoom - 1, not 1 to PlayersPerRoom
    rooms[room]["numPlayers"] += 1;

    //First try to add them to an empty slot
    var tookEmptySlot = false;
    const roomSlots = rooms[room]["roomSlots"];
    for(const slot in roomSlots) {
        if(roomSlots[slot]["id"] === "_") {
            addToRoomSlot(id, room, slot)
            tookEmptySlot = true;
            //if the game has already started, send them the role and cards associated with this slot
            if(roomSlots[slot]["role"]) {
                const pSocket = io.sockets.sockets.get(id);
                pSocket.emit("GameStart", roomSlots[slot]["role"]);
            }
            break;
        }
    }
    if(!tookEmptySlot) { //otherwise create a new slot for them
        addToRoomSlot(id, room, pNum);
    }

    players[id]["actualRoom"] = room;

    if(updatePlayers) updateRoomPlayers(room);
}

//creates a room slot or adds player to existing room slot
function addToRoomSlot(id, room, slot) {
    if(!rooms[room]["roomSlots"][slot]) {
        rooms[room]["roomSlots"][slot] = {};
        rooms[room]["roomSlots"][slot]["ready_status"] = false;
    }
    rooms[room]["roomSlots"][slot]["id"] = id;
    players[id]["roomSlot"] = slot;
}

function checkReadyPlayers(roomNum) {
    const slots = rooms[roomNum]["roomSlots"];
    var numReady = 0;
    var totalPlayers = 0;

    for(const slot in slots) {
        if(slots[slot]["ready_status"]) numReady += 1;
        totalPlayers += 1;
    }

    io.to(roomNum).emit("NumberOfReadyPlayers", numReady);
    return (numReady >= totalPlayers);
}

//sends all players in a room the list of usernames of players in that room. Determining who joined/left is done client side.
function updateRoomPlayers(room) {
    room = String(room);
    var userNamesList = [];
    const slots = rooms[room]["roomSlots"];

    for(const slot in slots) {
        if(slots[slot]["id"] !== "_") userNamesList.push(players[slots[slot]["id"]]["username"]);
    }
    io.to(room).emit("UpdatePlayers", userNamesList);
    checkReadyPlayers(room);
}

function closeRoom(room) {
    const slots = rooms[room]["roomSlots"];
    for(const slot in slots) {
        if(slots[slot]["id"] === "_") continue;

        const id = slots[slot]["id"];

        if(players[id]["actualRoom"] == room) {
            players[id]["actualRoom"] = "";
            players[id]["requestedRoom"] = "";
        }

        const sock = io.sockets.sockets.get(id);
        if(!sock) continue;

        sock.leave(room);
    }
    delete roomRequests[rooms[room]["requestedRoomID"]]["successfulRooms"][room];
    delete rooms[room];
}

//assumes choice has been sanitized and slot corresponds to the active player
function addPlayedCard(room, choice) {
    const slot = rooms[room]["activePlayer"];
    const deck = rooms[room]["roomSlots"][slot]["deck"];
    const cardChoice = deck[choice];
    deck.splice(choice, 1);

    rooms[room]["playedCards"].push(cardChoice);

    rooms[room]["currentTurn"] += 1;
    rooms[room]["activePlayer"] = (rooms[room]["activePlayer"]+1)%5; //change the mod 5 for different player amounts
    runTurn(room);
}

function runTurn(room) {
    const numPlayers = 5; //change if adding functionality for different numbers of players
    const currentTurn = rooms[room]["currentTurn"];
    const activePlayer = rooms[room]["activePlayer"];

    if(currentTurn >= numPlayers) {
        endRound(room);
    }
    else {
        const slot = rooms[room]["roomSlots"][activePlayer];
        const hand = slot["deck"].slice(0, 3);
        SHUFFLE_ARRAY(rooms[room]["playedCards"]);

        io.to(room).emit("TurnIsOccurring", activePlayer);
        if(!players[slot["id"]]["isBot"]) io.to(slot["id"]).emit("TakeTurn", hand, rooms[room]["playedCards"]);
        else {
            setTimeout(() => {
                runBotTurn(room, slot, hand, rooms[room]["playedCards"])
            }, 1000); //recursive since this will call addPlayedCard
        }
    }
}

function startRound(room) {
    const currentRound = rooms[room]["currentRound"];
    const attackers = rooms[room]["attackDeck"].slice(currentRound*2, currentRound*2+2);
    rooms[room]["currentTurn"] = 0;
    rooms[room]["activePlayer"] = (4*rooms[room]["phase"] + currentRound - 4)%5; //a lot to change for different pNums

    io.to(room).emit("RoundStart", attackers);
    rooms[room]["playedCards"] = [];
    runTurn(room); //after this runTurn is called on player responses
}

function checkAttackersDefeated(attackers, playedCards) {
    const attackScore = 3*attackers[0].value + 2*attackers[1].value;

    var sum = 0;
    var suitMatch = false;
    var prime = false;
    for(const card of playedCards) {
        sum += card.value;
        if(PRIMES.includes(card.value)) prime = true;
        if(attackers[1].suit === card.suit) suitMatch = true;
    }

    return ((sum > attackScore) && suitMatch && prime);
}

function endRound(room) {
    const currentRound = rooms[room]["currentRound"];
    const attackers = rooms[room]["attackDeck"].slice(currentRound*2, currentRound*2+2);
    const playedCards = rooms[room]["playedCards"];

    const successfulDefense = checkAttackersDefeated(attackers, playedCards);
    
    if(successfulDefense) {
        io.to(room).emit("RoundEnd", true, playedCards);
    }
    else {
        io.to(room).emit("RoundEnd", false, playedCards);
        rooms[room]["assassinations"] += 1;
        if(rooms[room]["assassinations"] >= 4) {
            endGame(room);
            return;
        }
    }

    if(currentRound >= 3) { //4 rounds in a phase (0-3)
        endPhase(room);
    }
    else {
        rooms[room]["currentRound"] += 1;
        startRound(room);
    }
}

function startPhase(room) {
    const deck = new Cards_Deck();
    const numPlayers = 5; //change so different player numbers can work
    const slots = rooms[room]["roomSlots"];

    for(var i = 0; i < numPlayers; i++) {
        const slotDeck = deck.cards.slice(i*6, i*6+6);
        slots[i]["deck"] = slotDeck;
    }

    rooms[room]["attackDeck"] = deck.cards.slice(numPlayers*6);
    rooms[room]["currentRound"] = 0;
    rooms[room]["phase"] += 1;

    startRound(room);
}

function endPhase(room) {
    const phase = rooms[room]["phase"];

    if(phase === 1) {
        startPhase(room);
    } else {
        endGame(room);
    }
}

function startGame(room) {
    const roles = new Roles_Deck();
    const roomSlots = rooms[room]["roomSlots"];
    for(var slot in roomSlots) {
        const role = roles.roles[parseInt(slot)];
        roomSlots[slot]["role"] = role;
        if(role.suit.includes("Joker")) rooms[room]["knaveSlot"] = slot;

        if(players[roomSlots[slot]["id"]]["isBot"]) continue; //skip emitting for bots

        const pID = roomSlots[slot]["id"];
        const pSocket = io.sockets.sockets.get(pID);
        pSocket.emit("GameStart", role);
    }
    rooms[room]["phase"] = 0;
    rooms[room]["assassinations"] = 0;

    startPhase(room);
}

function endGame(room) {
    var numA = rooms[room]["assassinations"];
    io.to(room).emit("endGame", numA);
    if(numA != 3) {
        //either knights or knaves won outright, no need for voting
        closeRoom(room);
    } 
    else {
        //voting will occur
        rooms[room]["votes"] = [];
        const roomSlots = rooms[room]["roomSlots"];
        for(slot in roomSlots) roomSlots[slot]["hasVoted"] = false;

        for(slot in roomSlots) {
            const id = roomSlots[slot]["id"];
            if(players[id]["isBot"] == false) continue; //skip players
            
            //pick vote, has to be adjusted for different player numbers
            const options = [0, 1, 2, 3, 4];
            options.splice(parseInt(slot), 1); //ensures the bots don't vote themselves
            const vote = options[Math.floor(Math.random()*4)];
            const slotVotedFor = roomSlots[vote];

            io.to(room).emit("Message_Recieve", players[id]["username"], "Voted for " + players[slotVotedFor["id"]]["username"] + ".");
            countVote(room, vote);
        }
    }
}

function countVote(room, vote) {
    const voteArray = rooms[room]["votes"];
    voteArray.push(vote); //votes should be a slot number

    if(voteArray.length >= rooms[room]["numPlayers"]) {
        const knaveSlot = rooms[room]["knaveSlot"];
        const roomSlots = rooms[room]["roomSlots"];

        for(vote of voteArray) {
            if(roomSlots[vote]["voteTally"]) roomSlots[vote]["voteTally"] += 1;
            else roomSlots[vote]["voteTally"] = 1;
        }
        const knaveVotes = roomSlots[knaveSlot]["voteTally"];

        var knaveWins = false;
        
        for(slot in roomSlots) {
            if(slot == knaveSlot) continue;
            if(roomSlots[slot]["voteTally"] >= knaveVotes) {
                knaveWins = true;
                break;
            }
        }

        io.to(room).emit("endVoting", knaveSlot, knaveWins);

        closeRoom(room);
    }
}

function createBot(requestedRoom, botNumber) {
    const bot_playerID = "bot#" + globalBotID;
    globalBotID = (globalBotID + 1) | 0;
    
    players[bot_playerID] = {};
    players[bot_playerID]["isBot"] = true;
    players[bot_playerID]["username"] = "Bot " + botNumber;
    players[bot_playerID]["requestedRoom"] = requestedRoom;
    
    addToWaitingList(requestedRoom, bot_playerID);
}

function runBotTurn(room, slot, hand, playedCards) {
    if(!rooms[room]) return; //room was closed before timeout finished.
    const role = slot["role"];
    const currentRound = rooms[room]["currentRound"];
    const attackers = rooms[room]["attackDeck"].slice(currentRound*2, currentRound*2+2);
    
    const isKnave = role.suit.includes("Joker"); //info for deciding what to do
    const defendersAlreadyWon = checkAttackersDefeated(attackers, playedCards); //if true simply try to improve hand
    const suitNeeded = attackers[1].suit;

    var cardChoice = 0;

    if(defendersAlreadyWon) {
        if(isKnave) { //Knave wants to play their best card
            if(hand[0].value >= hand[1].value && hand[0].value >= hand[2].value) cardChoice = 0;
            else if(hand[1].value >= hand[0].value && hand[1].value >= hand[2].value) cardChoice = 1;
            else cardChoice = 2;
        } else { //Knight wants to play their worst card
            if(hand[0].value <= hand[1].value && hand[0].value <= hand[2].value) cardChoice = 0;
            else if(hand[1].value <= hand[0].value && hand[1].value <= hand[2].value) cardChoice = 1;
            else cardChoice = 2;
        }
    } 
    else {
        var suitReqMet = false; //need more info for decision making if our choice actually matters
        var primeReqMet = false;
        for(card in playedCards) {
            if(card.suit == suitNeeded) suitReqMet = true;
            if(PRIMES.includes(card.value)) primeReqMet = true;
        }

        const cardScores = [0, 0, 0]; //Score cards on how good they are to play, knight picks highest knave picks lowest
        for(var i = 0; i < 3; i++) {
            const cardIsPrime = PRIMES.includes(hand[i].value);
            const cardIsSuit = (hand[i].suit == suitNeeded);
            
            cardScores[i] = hand[i].value + (cardIsPrime && !primeReqMet)*7 + (cardIsSuit && !suitReqMet)*10
            //current algo highly prioritizes suits and primes when needed, which seems right but might need to be revisited
            //smarter bots would save better cards rather than using an ace when all they need is a two
        }

        if(isKnave) { //Knave wants to play the worst card
            if(cardScores[0] <= cardScores[1] && cardScores[0] <= cardScores[2]) cardChoice = 0;
            else if(cardScores[1] <= cardScores[0] && cardScores[1] <= cardScores[2]) cardChoice = 1;
            else cardChoice = 2;
        } else { //Knight wants to play the best card
            if(cardScores[0] >= cardScores[1] && cardScores[0] >= cardScores[2]) cardChoice = 0;
            else if(cardScores[1] >= cardScores[0] && cardScores[1] >= cardScores[2]) cardChoice = 1;
            else cardChoice = 2;
        }
    }
    
    addPlayedCard(room, cardChoice);
}

//when a new user connects to the server, this runs for their socket.
io.on("connection", (socket) => {
    players[socket.id] = {}; //document the player

    //when the socket disconnects from the server
    socket.on("disconnect", (reason) => {
        disconnectPlayer(reason, socket);
    });
    
    //players will ping the server for a Check In event when moving to the Game_Found page
    //this code will add them to the waiting list for their requested room, and create the room if enough people are waiting
    socket.on("CheckIn", (UserName, UserRoom) => {
        checkInPlayer(socket, UserName, UserRoom);
    });

    //When players send a message they will emit this event for us to emit to the rest of the room.
    socket.on("Message_Send", (text) => {
        if(!players[socket.id]["actualRoom"]) return;
        text = validateInput(text);
        io.to(players[socket.id]["actualRoom"]).emit("Message_Recieve", players[socket.id]["username"], text);
    });

    socket.on("PlayerReadyStateChange", (state) => {
        if(!players[socket.id]["actualRoom"]) return;
        const roomNum = players[socket.id]["actualRoom"];
        const room = rooms[roomNum];
        const playerSlot = players[socket.id]["roomSlot"];

        room["roomSlots"][playerSlot]["ready_status"] = (state === "Ready");

        if(checkReadyPlayers(roomNum)) startGame(roomNum);
    });

    socket.on("PlayerCardChoice", (choice) => {
        if(choice !== 0 && choice !== 1 && choice !== 2) return; //invalid choice

        const room = rooms[players[socket.id]["actualRoom"]];
        if(!room) return; //not in a room yet
        
        const slot = players[socket.id]["roomSlot"];
        if(room["activePlayer"] != slot) return; //not their turn yet

        addPlayedCard(players[socket.id]["actualRoom"], choice);
    });

    socket.on("Player_Vote", (vote) => {
        const room = players[socket.id]["actualRoom"];
        if(!room || !rooms[room]) return; //room closed
        const slotVotedFor = rooms[room]["roomSlots"][vote]
        if(!slotVotedFor) return;

        const senderSlot = players[socket.id]["roomSlot"];
        if(rooms[room]["roomSlots"][senderSlot]["hasVoted"]) return; //prevent voting multiple times
        else rooms[room]["roomSlots"][senderSlot]["hasVoted"] = true;

        io.to(room).emit("Message_Recieve", players[socket.id]["username"], "Voted for " + players[slotVotedFor["id"]]["username"] + ".");
        countVote(room, vote);
    });

    socket.on("RequestBots", () => {
        const requestedRoom = players[socket.id]["requestedRoom"];
        var numPlayersInLine = -1; //starts at -1 to account for the successfulRooms key
        for(const player in roomRequests[requestedRoom]) numPlayersInLine += 1;

        for(var i = 0; i < playersPerRoom - numPlayersInLine; i++) { //create enough bots to start the game
            createBot(requestedRoom, i);
        }

        //set the bots as ready
        const actualRoom = players[socket.id]["actualRoom"];
        for(const slot in rooms[actualRoom]["roomSlots"]) {
            const slotId = rooms[actualRoom]["roomSlots"][slot]["id"];
            if(!players[slotId]["isBot"]) continue; //skip real players

            rooms[actualRoom]["roomSlots"][slot]["ready_status"] = true;
        }
        checkReadyPlayers(actualRoom); //updates the ready count for players on the frontend.
    }); 
});

server.listen(port, () => {
    console.log("Listening on port " + port);
});
