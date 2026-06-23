const dns = require("node:dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require('express');
const app = express()
const cors = require('cors');

require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;
app.use(cors());
app.use(express.json());
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});
app.get('/', (req, res) => {
    res.send('Hello World!')
})
async function run() {
    try {

        // await client.connect();
        const db = client.db("recipely-db");
        const usersCollection = db.collection("user");
        const recipesCollections = db.collection('recipes')

        // user related api 
        app.get('/api/users', async (req, res) => {
            const users = await usersCollection.find().toArray();
            res.send(users);
        });

        //  recipe related api 
        app.post('/api/recipes', async (req, res) => {
            const recipe = req.body;
            const newRecipe = await recipesCollections.insertOne(recipe);
            res.send(newRecipe);
        });
        app.get('/api/my-recipe', async (req, res) => {
            let query = {};
            if (req.query.authorId) {
                query.authorId = req.query.authorId
            }
            const cursor = recipesCollections.find(query);
            const recipes = await cursor.toArray();
            res.send(recipes);
        })
        app.get('/api/my-recipe/:id', async (req, res) => {
            const id = req.params.id;
            console.log(id);

            const query = { _id: new ObjectId(id) };
            const recipe = await recipesCollections.findOne(query);
            res.send(recipe);
        })
        app.patch('/api/my-recipe/:id', async (req, res) => {
            const id = req.params.id;
            const recipe = req.body;
            const query = { _id: new ObjectId(id) };
            const updateRecipe = await recipesCollections.updateOne(query, { $set: recipe });
            res.send(updateRecipe);
        })
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);



app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})