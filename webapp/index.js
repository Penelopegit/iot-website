require("dotenv").config()
const app_url = `${process.env.SCHEME}://${process.env.HOSTNAME}:${process.env.PORT}`
const express = require("express")
const path = require("path")
const { auth, requiresAuth } = require("express-openid-connect")
const multer = require("multer")
const moment = require("moment")
const storage = multer.memoryStorage()
const uploadOptions = { 
    storage: storage,
    fileFilter: function(req, file, cb) {
        const allowedExtensions = [".json"]
        if (allowedExtensions.includes(path.extname(file.originalname).toLowerCase())) {
            return cb(null, true)
        }
        cb("Error: Only json files allowed")
    }
}
const upload = multer(uploadOptions)

const mongoose = require("mongoose")
mongoose.connect("mongodb://localhost:27017/sensors")
const app = express()

app.use(express.json())

const sensorsSchema = new mongoose.Schema({
    sender: String,
    topic: String,
    message: String,
    unixtime: Number,
    timestamp: { type : Date }
})
const userRecordSchema = new mongoose.Schema(
    {
        sensorName: String, 
        sensorValue: String, 
        timestamp: { type : Date },
        userId: String, 
        groupId: String,
        description: String,
        originalFileName: String
    },
    {
        timestamps: true,
    }
)
const purchasesSchema = new mongoose.Schema(
    {
        purchasedBy: String, 
        dataId: String, 
        ownData: Boolean
    }, 
    {
        timestamps: true
    }
)

const sensorsModel = mongoose.model("sensors",sensorsSchema)
const userRecordModel = mongoose.model("userRecord", userRecordSchema)
const purchasesModel = mongoose.model("purchases", purchasesSchema)


app.get("/getsensors", (req, res) => {
    sensorsModel.find({}).then(function(sensors){
        res.json(sensors)
    }).catch(function(err){
        console.log(err)
    })
}) 

app.get("/download/:sender", (req, res) => {
    const sender = req.params.sender;
    sensorsModel.find({ sender: sender }).exec()
        .then((sensors) => {
            if (!sensors || sensors.length === 0) {
                res.status(404).send("Data not found for this sender");
                return;
            }
            const data = JSON.stringify(sensors, null, 2);
            res.setHeader('Content-disposition', 'attachment; filename=sensor_data.json');
            res.setHeader('Content-type', 'application/json');
            res.send(data);
        })
        .catch((err) => {
            console.log(err);
            res.status(500).send("Internal Server Error");
        });
});



const checkRequiredRoles = (requiredRoles) => {
    return (req, res, next) => {
        const proceed =
            requiredRoles.every(role => req.oidc.user.app_roles?.includes(role))
        if (proceed) {
            return next()
        } else {
            //TODO: ...forbidden
        }
    }
} 



app.use(
    auth({
        issuerBaseURL: process.env.AUTH_ISSUER_BASE_URL,
        baseURL: app_url,
        clientID: process.env.AUTH_CLIENT_ID,
        secret: process.env.SESSION_SECRET,
        authRequired: false,
        auth0Logout: true,
        // authorizationParams: {
        //     scope: "openid profile email app_metadata"
        // },
    }),
);

app.set('view engine', 'ejs')

app.get("/", function (req, res) {
    res.render('index', {
        user: req.oidc.user
    })
})

app.get('/user_info', requiresAuth(), function (req, res) {
    res.json(req.oidc.user)
})

app.get("/something_private", requiresAuth(), checkRequiredRoles(["Buyer"]), function (req, res) {
    res.sendFile(path.join(__dirname, "pages/something_private.html"))
})

app.get("/seller", requiresAuth() , async function (req, res) {
    //find data uploaded by current user 
    const userId = req.oidc.user.name 
    const data = await userRecordModel.find({ userId: userId})
    const visited = new Set()
    const rows = []
    data.forEach(row => {
        if(!visited.has(row.groupId)) {
            visited.add(row.groupId)
            rows.push({
                groupId: row.groupId,
                uploadedAt: moment(row.createdAt).format("DD-MM-YYYY HH:mm:ss"),
                fileName: row.originalFileName,
                description: row.description || ""
            })
        }
    })
    const groupIds = rows.map(r => r.groupId)
    console.log("group ids:", groupIds)
    const purchasedData = await purchasesModel.find({ ownData: false, dataId: { $in: groupIds }})
    res.render("seller", {
        user: req.oidc.user, 
        data: rows,
        purchases: purchasedData.map(row => ({
            groupId: row.dataId,
            purchasedAt: moment(row.createdAt).format("DD-MM-YYYY HH:mm:ss"),
            purchasedBy: row.purchasedBy,
            description: rows.find(r => r.groupId == row.dataId).description,
            fileName: rows.find(r => r.groupId == row.dataId).fileName
        }))
    })
    //this is a change
});
app.get("/", function (req, res) {
    res.render('index', {
        user: req.oidc.user
    });
    res.redirect("/seller"); // redirect to the seller page
});

app.get('/DownloadGroupData/:groupId', requiresAuth(), async (req, res) => {
    const userId = req.oidc.user.name 
    const groupId = req.params.groupId
    const data = await userRecordModel.find({
        groupId: groupId
    })
    const fileName = data?.[0]?.userId == userId ? data[0].originalFileName : "data.json"
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Content-disposition",`attachment; filename=${fileName}`)
    res.send(data.map(r => ({
        sensorName: r.sensorName, 
        sensorValue: r.sensorValue, 
        timestamp: r.timestamp
    })))
})

app.delete('/Group/:groupId', requiresAuth(), async (req, res) => {
    try {
        const userId = req.oidc.user.name 
        await userRecordModel.deleteMany({
            groupId: req.params.groupId, 
            userId: userId
        })
        res.send("OK")
    } catch(error) {
        console.error(error)
        res.status(500).send("Internal Server Error")
    }
})

app.post('/uploadIOTData', requiresAuth(), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send("You need to upload a file")
        }
        let content = String(req.file.buffer)
        try {
            content = JSON.parse(content)
        } catch(parseError) {
            return res.status(400).send("Content can't be parsed as JSON file.")
        }
        if (!Array.isArray(content)) {
            return res.status(400).send("Expected JSON array")
        }
        const notSetValue = (val) => val === null || val === undefined || String(val).trim() === ''
        if (content.some(row => notSetValue(row.sensorName) || notSetValue(row.sensorValue))) {
            return res.status(400).send("Each row should contain sensorName and sensorValue fields")
        }
        const userId = req.oidc.user.name
        const groupId = `${userId}${Date.now()}`
        content = content.map(row => ({
            sensorName: row.sensorName, 
            sensorValue: row.sensorValue, 
            timestamp: row.timestamp || null, 
            userId: userId,
            groupId: groupId,
            originalFileName: req.file.originalname,
            description: req.body.Description || ""
        }))
        await userRecordModel.insertMany(content)
        res.send("File uploaded successfully")
    } catch (error) {
        console.error(error)
        res.status(500).send("Internal Server Error")
    }
})

app.post("/BuyData", requiresAuth(), async function(req, res) {
    try {
        console.log("####", req.body)
        const {dataId, ownData} = req.body
        //const modelToSearch = ownData == 'Y' ? sensorsModel : userRecordModel
        //console.log("searching on", modelToSearch, "with", dataId)
        const data = ownData == 'Y'
            ?   await sensorsModel.findById(dataId)
            :   await userRecordModel.findOne({ groupId: dataId })
        console.log("data:", data)
        if (data == null) {
            return res.status(404).send("Error: Data not found!")
        }
        const purchase = {
            purchasedBy: req.oidc.user.name,
            dataId: dataId, 
            ownData: ownData == 'Y'
        }
        await purchasesModel.create(purchase)
        res.send("Purchase Completed Successfully!")
    } catch(error) {
        console.error(error)
        res.status(500).send("Internal Server Error")
    }
})

app.get("/buyer", requiresAuth(), async function (req, res) {
    let [ 
        sensorData, 
        userData
    ] = await Promise.all([
        sensorsModel.find({}),
        userRecordModel.find({})
    ])
    //Sender, Description, Quantity, Price, Download, Buy 
    const sensorQuantities = {} 
    const userQuantities = {}
    sensorData = sensorData.map(r => ({
        id: r._id,
        Sender: r.sender, 
        Description: r.topic,
    }))
    userData = userData.map(r => ({
        id: r._id,
        Sender: r.sensorName,
        Description: r.description,
        Group: r.groupId
    }))
    sensorData.forEach(r => {
        if (sensorQuantities.hasOwnProperty(r.Sender)) {
            sensorQuantities[r.Sender]++
        } else {
            sensorQuantities[r.Sender] = 1
        }
    })
    userData.forEach(r => {
        if (userQuantities.hasOwnProperty(r.Group)) {
            userQuantities[r.Group]++
        } else {
            userQuantities[r.Group] = 1
        }
    })
    const visitedUserGroups = new Set()
    const visitedSensors = new Set()
    const result = 
        userData
            .map(r => ({
                ...r, 
                Quantity: userQuantities[r.Group], 
                Price: 0.1 * userQuantities[r.Group],
                Own: false,
                Download: "/DownloadGroupData/" + r.Group,
                id: r.Group
            }))
            .filter( r => {
                if (visitedUserGroups.has(r.Group)) {
                    return false
                }
                visitedUserGroups.add(r.Group)
                return true
            })
            .concat(
                sensorData
                    .map(r => ({
                        ...r, 
                        Quantity: sensorQuantities[r.Sender],
                        Price: 0.1 * sensorQuantities[r.Sender],
                        Own: true,
                        Download: "/download/" + r.Sender
                    }))
                    .filter( r => {
                        if (visitedSensors.has(r.Sender)) {
                            return false
                        }
                        visitedSensors.add(r.Sender)
                        return true
                    })
            )
    res.render("buyer", {
        user: req.oidc.user,
        data: result
    })
});

app.get("/", function (req, res) {
    res.render('index', {
        user: req.oidc.user
    });
    res.redirect("/buyer");
});

app.get("/about", function (req, res) {
    res.render("about", {
        user: req.oidc.user
    });
});



app.use("/static", express.static(path.join(__dirname, "static")))


app.listen(process.env.PORT, function (err) {
    if (err) {
        console.error("Encountered error while listening:", err)
    } else {
        console.log("Server ready at port:", process.env.PORT)
    }
})