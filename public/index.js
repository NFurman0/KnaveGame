const UserName = document.getElementById("UserName");
const UserRoom = document.getElementById("UserRoom");

function setLocalVars() {
    localStorage["UserName"] = UserName.value;
    localStorage["UserRoom"] = UserRoom.value;
}