const dns = require("node:dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require('express');
const app = express()
const cors = require('cors');

require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");

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
const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send("Unauthorized")
    };
    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).send("Unauthorized")
    }
    try {
        const { payload } = await jwtVerify(token, JWKS);
        req.user = payload;
        next();
    } catch (error) {
        return res.status(401).send("Unauthorized")
    }
}
const verifyOptionalToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        if (token && token !== "undefined" && token !== "null") {
            try {
                const { payload } = await jwtVerify(token, JWKS);
                req.user = payload;
            } catch (error) {
                // Ignore error for optional token
            }
        }
    }
    next();
}
const verifyUser = async (req, res, next) => {
    const user = req.user;
    if (user.role !== 'user') {
        return res.status(403).send("Forbidden")
    }
    next();
}
const verifyAdmin = async (req, res, next) => {
    const user = req.user;
    if (user.role !== 'admin') {
        return res.status(403).send("Forbidden")
    }
    next();
}
const verifyAdminOrUser = async (req, res, next) => {
    const user = req.user;
    if (user.role !== 'user' && user.role !== 'admin') {
        return res.status(403).send("Forbidden");
    }
    next();
}
app.get('/', (req, res) => {
    res.send('Hello World!')
})
async function run() {
    try {

        // await client.connect();
        const db = client.db("recipely-db");
        const usersCollection = db.collection("user");
        const recipesCollections = db.collection('recipes')
        const reportsCollection = db.collection('reports')
        const favoritesCollection = db.collection('favorites')
        const userCollection = db.collection('user')
        const plansCollection = db.collection('plans')
        const transactionsCollection = db.collection('transactions')
        // user related api
        // get all users
        app.get('/api/users/all', verifyToken, verifyAdmin, async (req, res) => {
            const users = await userCollection.find().toArray();
            res.send(users);
        });
        app.get('/api/user/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const user = await userCollection.findOne(query);
            res.send(user);
        })
        // user change status
        app.patch('/api/users/status', verifyToken, verifyAdmin, async (req, res) => {
            const userId = req.query.userId;
            const status = req.query.status === "true" ? true : false;
            const query = { _id: new ObjectId(userId) };
            const updateUser = await userCollection.updateOne(query, { $set: { isBlocked: status } });
            res.send(updateUser);
        })
        // change isFeatured status
        app.patch('/api/featured/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const status = req.query.isFeatured === "true" ? true : false;
            const query = { _id: new ObjectId(id) };
            const updateUser = await recipesCollections.updateOne(query, { $set: { isFeatured: status } });
            res.send(updateUser);
        })
        //  recipe related api 
        // create recipe
        app.post('/api/recipes', verifyToken, verifyUser, async (req, res) => {
            const recipe = req.body;
            const newRecipe = await recipesCollections.insertOne(recipe);
            res.send(newRecipe);
        });
        // get all recipes
        app.get('/api/recipes', async (req, res) => {
            const { page = 1, limit = 12, category, search, cuisineType, difficultyLevel } = req.query;
            const skip = (Number(page) - 1) * Number(limit);
            let query = {};
            if (search) {
                query.recipeName = { $regex: search, $options: 'i' }
            }
            if (category) {
                query.category = { $in: [category] }
            }
            if (cuisineType) {
                query.cuisineType = { $in: [cuisineType] }
            }
            if (difficultyLevel) {
                query.difficultyLevel = { $in: [difficultyLevel] }
            }
            const cursor = recipesCollections.find(query).skip(skip).limit(Number(limit)).sort({ createdAt: -1 });
            const recipes = await cursor.toArray();
            const total = await recipesCollections.countDocuments(query);
            const totalPages = Math.ceil(total / limit);
            res.send({ data: recipes, totalPages, page, limit });
        })
        // get all recipe to use admin 
        app.get('/api/recipes/admin', verifyToken, verifyAdmin, async (req, res) => {
            const cursor = recipesCollections.find().sort({ createdAt: -1 });
            const recipes = await cursor.toArray();
            res.send(recipes);
        })
        // get all recipes by author
        app.get('/api/my-recipe', verifyToken, verifyUser, async (req, res) => {
            let query = {};
            if (req.query.authorId) {
                query.authorId = req.query.authorId
            }
            const cursor = recipesCollections.find(query);
            const recipes = await cursor.toArray();
            res.send(recipes);
        })
        // get check payment recipe
        // Get single recipe details with payment verification
        app.get('/api/recipes/details/:id', verifyToken, async (req, res) => {
            try {
                const recipeId = req.params.id;
                const userId = req.user._id || req.user.id || req.user.sub;

                if (!ObjectId.isValid(recipeId)) {
                    return res.status(400).send({ message: "Invalid Recipe ID format" });
                }

                // 1. Fetch the recipe
                const recipe = await recipesCollections.findOne({ _id: new ObjectId(recipeId) });
                if (!recipe) {
                    return res.status(404).send({ message: "Recipe not found" });
                }

                // 2. Check ownership, admin status, premium status, or payment record
                const isAuthor = recipe.authorId === userId;
                const isAdmin = req.user.role === 'admin';

                const userDoc = await userCollection.findOne({ _id: new ObjectId(userId) });
                const isPremium = !!userDoc?.isPremium;

                const paymentRecord = await transactionsCollection.findOne({
                    userId: userId,
                    recipeId: recipeId,
                    purchaseType: 'recipe',
                    paymentStatus: 'succeeded'
                });

                // Determine paymentStatus string based on condition
                let paymentStatus = "unpaid";

                if (isAuthor) {
                    paymentStatus = "owner";
                } else if (isAdmin || isPremium || !!paymentRecord) {
                    paymentStatus = "paid";
                }

                // 3. Conditional payload response based on access level
                if (paymentStatus === "owner" || paymentStatus === "paid") {
                    return res.send({
                        ...recipe,
                        paymentStatus
                    });
                } else {
                    // Strip out restricted fields (instructions & ingredients)
                    const { instructions, ingredients, ...publicRecipeData } = recipe;
                    return res.send({
                        ...publicRecipeData,
                        paymentStatus: "unpaid"
                    });
                }

            } catch (error) {
                console.error("Error fetching recipe details:", error);
                return res.status(500).send({ message: "Internal server error" });
            }
        });
        // get featured recipes (highest 8)
        app.get('/api/recipes/featured', async (req, res) => {
            const limit = Number(req.query.limit) || 8;
            const cursor = recipesCollections.find({ isFeatured: true }).sort({ createdAt: -1 }).limit(limit);
            const recipes = await cursor.toArray();
            res.send(recipes);
        })
        // get popular recipes
        app.get('/api/recipes/popular', async (req, res) => {
            const { page = 1, limit = 8 } = req.query;
            const skip = (Number(page) - 1) * Number(limit);
            const query = { likes: -1, createdAt: -1 };
            const cursor = recipesCollections.find().sort(query).skip(skip).limit(Number(limit));
            const total = await recipesCollections.countDocuments();
            const totalPages = Math.ceil(total / limit);
            const recipes = await cursor.toArray();
            res.send({ recipes: recipes, totalPages, page, limit });
        })
        // get recipe by author this month
        app.get('/api/my-recipe/this-month', verifyToken, verifyUser, async (req, res) => {
            try {
                let query = {};
                if (req.query.authorId) {
                    query.authorId = req.query.authorId;
                }
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); // e.g., 2026-06-01T00:00:00.000Z
                const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
                query.createdAt = {
                    $gte: startOfMonth.toISOString(),
                    $lte: endOfMonth.toISOString()
                };
                const cursor = recipesCollections.find(query);
                const recipes = await cursor.toArray();
                res.send(recipes);
            } catch (error) {
                res.status(500).send({ error: "Failed to fetch this month's recipes" });
            }
        });
        // get recipe by id
        app.get('/api/my-recipe/:id', verifyOptionalToken, async (req, res) => {
            try {
                const id = req.params.id;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid Recipe ID format" });
                }
                const query = { _id: new ObjectId(id) };
                const recipe = await recipesCollections.findOne(query);
                if (!recipe) {
                    return res.status(404).send({ message: "Recipe not found" });
                }

                let isPaid = false;

                if (req.user) {
                    const userId = req.user._id || req.user.id || req.user.sub;
                    const isAuthor = recipe.authorId === userId;
                    const isAdmin = req.user.role === 'admin';

                    const paymentRecord = await transactionsCollection.findOne({
                        userId: userId,
                        recipeId: id,
                        purchaseType: 'recipe',
                        paymentStatus: 'succeeded'
                    });

                    const userDoc = await userCollection.findOne({ _id: new ObjectId(userId) });
                    const isPremium = userDoc?.isPremium;

                    isPaid = !!paymentRecord || isAuthor || isAdmin || isPremium;
                }

                if (isPaid) {
                    return res.send({ ...recipe, paymentStatus: "paid" });
                } else {
                    const { instructions, ingredients, ...publicRecipeData } = recipe;
                    return res.send({ ...publicRecipeData, paymentStatus: "unpaid" });
                }
            } catch (error) {
                console.error("Error fetching recipe:", error);
                return res.status(500).send({ message: "Internal server error" });
            }
        })
        // update recipe
        app.patch('/api/my-recipe/:id', verifyToken, verifyAdminOrUser, async (req, res) => {
            const id = req.params.id;
            const recipe = req.body;
            const query = { _id: new ObjectId(id) };
            const updateRecipe = await recipesCollections.updateOne(query, { $set: recipe });
            res.send(updateRecipe);
        })
        //delete recipe
        app.delete('/api/my-recipe/:id', verifyToken, verifyAdminOrUser, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const deleteRecipe = await recipesCollections.deleteOne(query);
            res.send(deleteRecipe);
        })
        //increment likes
        app.patch('/api/my-recipe/:id/like', verifyToken, async (req, res) => {
            const id = req.params.id;
            const userId = req.query.userId;
            const query = { _id: new ObjectId(id) };
            const updateRecipe = await recipesCollections.updateOne(query, {
                $inc: { likes: 1 },
                $push: { likedBy: userId }
            });
            res.send(updateRecipe);
        })

        // decrement likes
        app.patch('/api/my-recipe/:id/dislike', verifyToken, async (req, res) => {
            const id = req.params.id;
            const userId = req.query.userId;
            const query = { _id: new ObjectId(id) };
            const updateRecipe = await recipesCollections.updateOne(query, {
                $inc: { likes: -1 },
                $pull: { likedBy: userId }
            });
            res.send(updateRecipe);
        })
        //report recipe
        app.post('/api/report', verifyToken, async (req, res) => {
            const report = req.body;
            const newReport = await reportsCollection.insertOne(report);
            res.send(newReport);
        })
        // add recipe to favorites
        app.post('/api/favorite', verifyToken, async (req, res) => {
            const data = req.body;
            const updateRecipe = await favoritesCollection.insertOne(data);
            res.send(updateRecipe);
        })
        // remove recipe from favorites
        app.delete('/api/favorite/:recipeId/:userId', verifyToken, async (req, res) => {
            const recipeId = req.params.recipeId;
            const userId = req.params.userId;
            const query = { recipeId: recipeId, userId: userId };
            const deleteRecipe = await favoritesCollection.deleteOne(query);
            res.send(deleteRecipe);
        })
        // get favorites by user email
        app.get('/api/my-recipe/favorite/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const query = { userEmail: email };
            const result = await favoritesCollection.find(query).toArray();
            res.send(result);
        })
        app.get('/api/reports', verifyToken, verifyAdmin, async (req, res) => {
            const cursor = reportsCollection.find();
            const reports = await cursor.toArray();
            res.send(reports);
        })
        // remove report
        app.delete('/api/reports/:id/dismiss', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const deleteReport = await reportsCollection.deleteOne(query);
            res.send(deleteReport);
        })
        // get all premium users
        app.get('/api/users/premium', verifyToken, verifyAdmin, async (req, res) => {
            const query = { isPremium: true };
            const cursor = usersCollection.find(query);
            const users = await cursor.toArray();
            res.send(users);
        })
        // change isPremium status
        app.patch('/api/users/premium/:userId', verifyToken, async (req, res) => {
            const userId = req.params.userId;
            const status = req.query.isPremium === "true" ? true : false;
            const query = { _id: new ObjectId(userId) };
            const updateUser = await usersCollection.updateOne(query, { $set: { isPremium: status } });
            res.send(updateUser);
        })
        // get plan by isPremium
        app.get('/api/plan', async (req, res) => {
            const status = req.query.isPremium === "true" ? "premium" : 'free';
            const query = { planId: status };
            const result = await plansCollection.findOne(query);
            res.send(result);
        })
        // get all plans
        app.get('/api/plans/all', async (req, res) => {
            const cursor = plansCollection.find();
            const plans = await cursor.toArray();
            res.send(plans);
        })
        // transactions related api
        // post transaction
        app.post('/api/transactions', verifyToken, verifyUser, async (req, res) => {
            const transaction = req.body;
            const newTransaction = await transactionsCollection.insertOne(transaction);
            res.send(newTransaction);
        })
        // get transaction by user Id
        app.get('/api/transactions/:userId', verifyToken, verifyUser, async (req, res) => {
            const userId = req.params.userId
            const query = { userId: userId, purchaseType: 'recipe' }
            const cursor = transactionsCollection.find(query)
            const transaction = await cursor.toArray()
            res.send(transaction)
        })
        // dashboard overview api endpoints
        app.get('/api/dashboard/admin/overview', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const [totalUsers, totalRecipes, totalPremiumUsers, totalReports] = await Promise.all([
                    usersCollection.countDocuments(),
                    recipesCollections.countDocuments(),
                    usersCollection.countDocuments({ isPremium: true }),
                    reportsCollection.countDocuments()
                ]);

                res.send({
                    totalUsers,
                    totalRecipes,
                    totalPremiumUsers,
                    totalReports
                });
            } catch (error) {
                console.error("Error fetching admin dashboard overview:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        app.get('/api/dashboard/user/overview', verifyToken, async (req, res) => {
            try {
                const userId = req.user._id || req.user.id || req.user.sub;
                const userEmail = req.user.email;

                const [myRecipesCount, favoritesCount, purchasedCount, userDoc, likesAgg] = await Promise.all([
                    recipesCollections.countDocuments({ authorId: userId }),
                    userEmail ? favoritesCollection.countDocuments({ userEmail: userEmail }) : (userId ? favoritesCollection.countDocuments({ userId: userId }) : 0),
                    transactionsCollection.countDocuments({ userId: userId, purchaseType: 'recipe' }),
                    ObjectId.isValid(userId) ? usersCollection.findOne({ _id: new ObjectId(userId) }) : null,
                    recipesCollections.aggregate([
                        { $match: { authorId: userId } },
                        { $group: { _id: null, totalLikes: { $sum: "$likes" } } }
                    ]).toArray()
                ]);

                const totalLikesReceived = likesAgg[0]?.totalLikes || 0;
                const isPremium = !!userDoc?.isPremium;

                res.send({
                    totalRecipes: myRecipesCount,
                    totalFavorites: favoritesCount,
                    totalLikesReceived,
                    totalPurchased: purchasedCount,
                    isPremium
                });
            } catch (error) {
                console.error("Error fetching user dashboard overview:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        const reviewsCollection = db.collection('reviews');

        // ================= REVIEWS & RATINGS APIs =================
        // 1. Get all reviews for a recipe (Public)
        app.get('/api/reviews/:recipeId', async (req, res) => {
            try {
                const recipeId = req.params.recipeId;
                const reviews = await reviewsCollection
                    .find({ recipeId })
                    .sort({ createdAt: -1 })
                    .toArray();

                const totalReviews = reviews.length;
                const sumRating = reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0);
                const averageRating = totalReviews > 0 ? Math.round((sumRating / totalReviews) * 10) / 10 : 0;

                const ratingBreakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
                reviews.forEach(r => {
                    const stars = Math.min(5, Math.max(1, Math.round(r.rating || 5)));
                    ratingBreakdown[stars] = (ratingBreakdown[stars] || 0) + 1;
                });

                res.send({
                    reviews,
                    averageRating,
                    totalReviews,
                    ratingBreakdown
                });
            } catch (error) {
                console.error("Error fetching reviews:", error);
                res.status(500).send({ message: "Failed to fetch reviews" });
            }
        });

        // 2. Post or update a review (Verified Buyers / Unlocked Users only)
        app.post('/api/reviews', verifyToken, async (req, res) => {
            try {
                const { recipeId, rating, comment } = req.body;
                const userId = req.user._id || req.user.id || req.user.sub;

                if (!recipeId || !rating || !comment?.trim()) {
                    return res.status(400).send({ message: "Recipe ID, rating, and comment are required." });
                }

                const numRating = Number(rating);
                if (numRating < 1 || numRating > 5) {
                    return res.status(400).send({ message: "Rating must be between 1 and 5." });
                }

                if (!ObjectId.isValid(recipeId)) {
                    return res.status(400).send({ message: "Invalid Recipe ID format" });
                }

                const recipe = await recipesCollections.findOne({ _id: new ObjectId(recipeId) });
                if (!recipe) {
                    return res.status(404).send({ message: "Recipe not found." });
                }

                // Restriction: Author cannot rate their own recipe
                if (recipe.authorId === userId) {
                    return res.status(400).send({ message: "Authors cannot rate their own recipes." });
                }

                // Check verification: must have bought the recipe, be premium, be admin, or recipe must be free
                const paymentRecord = await transactionsCollection.findOne({
                    userId: userId,
                    recipeId: recipeId,
                    purchaseType: 'recipe',
                    paymentStatus: 'succeeded'
                });

                const userDoc = await userCollection.findOne({ _id: new ObjectId(userId) });
                const isPremium = !!userDoc?.isPremium;
                const isAdmin = req.user.role === 'admin';
                const isFree = !recipe.price || Number(recipe.price) === 0;

                const isVerifiedBuyer = !!paymentRecord || isPremium || isAdmin || isFree;

                if (!isVerifiedBuyer) {
                    return res.status(403).send({
                        message: "Only verified buyers who unlocked this recipe can write a review."
                    });
                }

                const userName = userDoc?.name || req.user.name || "Food Enthusiast";
                const userImage = userDoc?.image || req.user.image || null;

                const reviewDoc = {
                    recipeId,
                    userId,
                    userName,
                    userImage,
                    rating: numRating,
                    comment: comment.trim(),
                    isVerifiedBuyer: true,
                    updatedAt: new Date()
                };

                await reviewsCollection.updateOne(
                    { recipeId, userId },
                    { $set: reviewDoc, $setOnInsert: { createdAt: new Date() } },
                    { upsert: true }
                );

                // Recalculate average rating & review count for recipe
                const allReviews = await reviewsCollection.find({ recipeId }).toArray();
                const totalReviews = allReviews.length;
                const sumRating = allReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0);
                const averageRating = totalReviews > 0 ? Math.round((sumRating / totalReviews) * 10) / 10 : 0;

                await recipesCollections.updateOne(
                    { _id: new ObjectId(recipeId) },
                    { $set: { averageRating, totalReviews, reviewCount: totalReviews } }
                );

                res.send({
                    success: true,
                    message: "Thank you! Your verified review has been posted.",
                    review: reviewDoc,
                    averageRating,
                    totalReviews
                });
            } catch (error) {
                console.error("Error submitting review:", error);
                res.status(500).send({ message: "Internal server error submitting review" });
            }
        });

        // 3. Delete a review (Author of review or Admin)
        app.delete('/api/reviews/:id', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const userId = req.user._id || req.user.id || req.user.sub;
                const isAdmin = req.user.role === 'admin';

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid Review ID" });
                }

                const review = await reviewsCollection.findOne({ _id: new ObjectId(id) });
                if (!review) {
                    return res.status(404).send({ message: "Review not found" });
                }

                if (review.userId !== userId && !isAdmin) {
                    return res.status(403).send({ message: "You are not authorized to delete this review" });
                }

                await reviewsCollection.deleteOne({ _id: new ObjectId(id) });

                // Recalculate
                const allReviews = await reviewsCollection.find({ recipeId: review.recipeId }).toArray();
                const totalReviews = allReviews.length;
                const sumRating = allReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0);
                const averageRating = totalReviews > 0 ? Math.round((sumRating / totalReviews) * 10) / 10 : 0;

                await recipesCollections.updateOne(
                    { _id: new ObjectId(review.recipeId) },
                    { $set: { averageRating, totalReviews, reviewCount: totalReviews } }
                );

                res.send({ success: true, message: "Review deleted successfully" });
            } catch (error) {
                console.error("Error deleting review:", error);
                res.status(500).send({ message: "Failed to delete review" });
            }
        });

        // ================= AI CHEFBOT MULTILINGUAL API =================
        app.post('/api/ai-chat', async (req, res) => {
            try {
                const { message } = req.body;
                if (!message || !message.trim()) {
                    return res.status(400).send({ message: "Message is required" });
                }

                const userMsg = message.trim().toLowerCase();

                // Detect Language: Bangla Script, Banglish, or English
                const isBanglaScript = /[\u0980-\u09FF]/.test(message);
                const banglishWords = [
                    'ki', 'kivabe', 'korte', 'parbo', 'parbe', 'hobe', 'ranna', 'banabo', 'kore',
                    'dewa', 'jay', 'achhe', 'ache', 'amar', 'kase', 'bolo', 'bhalo', 'keno',
                    'khabar', 'khabo', 'dim', 'alu', 'aloo', 'murgi', 'goru', 'macher', 'ilish',
                    'porota', 'shorshe', 'mishti', 'jhol', 'moshla', 'chal', 'tel', 'ekta', 'kisu',
                    'khate', 'iccha', 'koro', 'amr', 'apni', 'tumi', 'bhai', 'kemn', 'aso', 'khobor'
                ];
                const isBanglish = !isBanglaScript && banglishWords.some(w => new RegExp(`\\b${w}\\b`, 'i').test(userMsg));

                // Bilingual Ingredient Dictionary for Database Searching
                const bnToEnMap = {
                    'dim': 'egg', 'ডিম': 'egg',
                    'alu': 'aloo', 'aloo': 'aloo', 'আলু': 'aloo',
                    'murgi': 'chicken', 'চিকেন': 'chicken', 'মুরগি': 'chicken',
                    'goru': 'beef', 'গরু': 'beef', 'বিফ': 'beef', 'kala bhuna': 'kala bhuna', 'কালা ভুনা': 'kala bhuna',
                    'ilish': 'ilish', 'ইলিশ': 'ilish', 'shorshe': 'shorshe', 'সরিষা': 'shorshe',
                    'biryani': 'biryani', 'বিরিয়ানি': 'biryani', 'kacchi': 'kacchi', 'কাচ্চি': 'kacchi',
                    'porota': 'paratha', 'paratha': 'paratha', 'পরোটা': 'paratha',
                    'pancake': 'pancake', 'প্যানকেক': 'pancake',
                    'begun': 'begun', 'বেগুন': 'begun',
                    'pasta': 'fettuccine', 'পাস্তা': 'fettuccine', 'fettuccine': 'fettuccine',
                    'doi': 'doi', 'দই': 'doi', 'bhapa doi': 'bhapa doi',
                    'tacos': 'tacos', 'spring roll': 'spring rolls', 'ভাত': 'rice', 'rice': 'rice', 'cha': 'tea'
                };

                // Extract keywords from user message
                let searchTerms = [];
                for (const [key, val] of Object.entries(bnToEnMap)) {
                    if (userMsg.includes(key)) {
                        searchTerms.push(val);
                        searchTerms.push(key);
                    }
                }

                // Add standard words
                const genericWords = userMsg
                    .replace(/[^\w\s\u0980-\u09FF]/gi, '')
                    .split(/\s+/)
                    .filter(w => w.length > 2 && !['how', 'what', 'can', 'with', 'make', 'cook', 'the', 'and', 'for', 'have', 'kivabe', 'korte', 'ranna'].includes(w));
                searchTerms = [...new Set([...searchTerms, ...genericWords])];

                let matchedRecipes = [];
                if (searchTerms.length > 0) {
                    const regexQueries = searchTerms.map(kw => ({
                        $or: [
                            { recipeName: { $regex: kw, $options: 'i' } },
                            { category: { $regex: kw, $options: 'i' } },
                            { cuisineType: { $regex: kw, $options: 'i' } },
                            { ingredients: { $regex: kw, $options: 'i' } }
                        ]
                    }));

                    matchedRecipes = await recipesCollections
                        .find({ $or: regexQueries })
                        .limit(3)
                        .toArray();
                }

                let reply = "";

                // 1. Google Gemini AI (Official SDK using GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY)
                const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
                if (geminiKey) {
                    try {
                        const { GoogleGenerativeAI } = require("@google/generative-ai");
                        const genAI = new GoogleGenerativeAI(geminiKey);
                        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                        const systemContext = `You are ChefBot, the friendly expert AI culinary assistant on the Recipely platform.
CRITICAL LANGUAGE RULES:
- If user writes in Bengali script (বাংলা), respond warmly in natural Bengali.
- If user writes in Banglish (Bengali transliterated in English alphabet, e.g. "dim r alu diye ki ranna kora jay", "buttermilk er bodole ki dewa jay", "kemn aso"), respond in friendly, natural Banglish!
- If user writes in English, respond in English.

Recipely available recipes matching context:
${matchedRecipes.map(r => `• ${r.recipeName} (Link: /all-recipes/${r._id}) - Category: ${r.category || 'Food'}, Time: ${r.preparationTime || 'Quick'}`).join('\n') || 'None'}

User query: "${message}"

Provide a delicious, helpful, and concise cooking response. Use bullet points and bold formatting. If matching Recipely recipes exist, mention them with their markdown links.`;

                        const result = await model.generateContent(systemContext);
                        reply = result.response.text();
                    } catch (gErr) {
                        console.error("Gemini API error, falling back to smart engine:", gErr.message);
                    }
                }

                // 2. Smart Multi-Language Fallback Engine
                if (!reply) {
                    if (isBanglish) {
                        // --- BANGLISH RESPONSES ---
                        if (userMsg.includes('substitute') || userMsg.includes('bodole') || userMsg.includes('bodla') || userMsg.includes('alternative')) {
                            if (userMsg.includes('buttermilk')) {
                                reply = "🥛 **Buttermilk er Substitute:**\n**1 cup regular dudh** er sathe **1 table-spoon lebur rosh ba white vinegar** mishiye 5 minute rekhe din. Dudh ta halka curdled holei apnar homemade buttermilk ready!";
                            } else if (userMsg.includes('dim') || userMsg.includes('egg')) {
                                reply = "🥚 **Dim (Egg) er Substitute:**\n- **Baking/Cake-e:** 1/4 cup mishti chara applesauce ba mashed banana.\n- **Pancake/Fluffiness:** 1 tbsp tishi (flaxseed powder) + 3 tbsp pani.\n- **Salad/Savory:** 1/4 cup tofu ba seddho alu mash.";
                            } else if (userMsg.includes('butter') || userMsg.includes('makha')) {
                                reply = "🧈 **Butter er Substitute:**\n- **Baking-e:** Shoman poriman coconut oil ba shadha tel.\n- **Ranna/Fry-te:** Olive oil ba shorishar tel use korte paren.";
                            } else {
                                reply = "🔄 **Chef Tip (Substitutes):**\nKono ingredient na thakle tar alternative use kora jay! Apnar kon ingredient er substitute lagbe bolun?";
                            }
                        } else if (userMsg.includes('dim') && (userMsg.includes('alu') || userMsg.includes('aloo'))) {
                            reply = "🍳 **Dim ar Alu diye Mojar Kichu Recipe Ideas:**\n1. **Dim Alur Dum / Korma:** Sheddho dim o alu bhalo kore veje moshla diye gravy banan.\n2. **Alu Dim Porota:** Seddho alu moshla diye mekey porotar vetor diye gorom gorom banan.\n3. **Dim Aloo Chop:** Seddho alur vetor dim er piece rekhe breadcrumb diye fry korun!";
                        } else if (userMsg.includes('quick') || userMsg.includes('jhotpot') || userMsg.includes('15') || userMsg.includes('taratari')) {
                            reply = "⚡ **15-20 Minute-e Jhotpot Ranna:**\n1. **Egg Fried Rice:** Dim, bhat, roshun o soy sauce diye 10 minute-e fried rice.\n2. **Garlic Butter Pasta:** Noodles sheddho kore roshun o butter diye toss korun.\n3. **Dim Bhaji & Paratha:** Piyaj, kacha morich diye dim mamlet o porota.";
                        } else if (userMsg.includes('healthy') || userMsg.includes('shastho') || userMsg.includes('diet') || userMsg.includes('weight')) {
                            reply = "🥗 **Healthy & Diet Ranna Tips:**\n- Kom tel o kom moshlay sobji o chicken grill ba boil korun.\n- Tel chara shobji shobuj rakhte steam korun, shathe roshun o lebur rosh din flavor-er jonno!";
                        } else if (userMsg.includes('hi') || userMsg.includes('hello') || userMsg.includes('kemn') || userMsg.includes('kemon') || userMsg.includes('ki khobor') || userMsg.includes('hey')) {
                            reply = "👋 **Hey! Ami ChefBot, Recipely-r AI Cooking Assistant!**\n\nApnar fridge-e ki ki ingredients ache bolun, ami shundor shundor recipe suggest kore dicchi. Ajke ki ranna korte chan?";
                        } else if (matchedRecipes.length > 0) {
                            reply = `👨‍🍳 **Apnar jonno Recipely-te shundor kichu recipe pawa geche:**`;
                        } else {
                            reply = `🍳 **ChefBot Cooking Recommendation:**\n**"${message}"** niye ranna korte chaile halka roshun, ada o shothik moshla diye ranna korle shwad darun hobe!`;
                        }

                        if (matchedRecipes.length > 0) {
                            reply += `\n\n✨ **Recipely Platform-er Match Kora Recipe:**\n` +
                                matchedRecipes.map(r => `• **[${r.recipeName}](/all-recipes/${r._id})** — *${r.category || 'Dish'} (${r.preparationTime || 'Quick'})*`).join('\n');
                        }
                    } else if (isBanglaScript) {
                        // --- BANGLA SCRIPT RESPONSES ---
                        if (userMsg.includes('বিকল্প') || userMsg.includes('বদলে') || userMsg.includes('পরিবর্তে')) {
                            if (userMsg.includes('ডিম')) {
                                reply = "🥚 **ডিমের বিকল্প উপাদান:**\n- **বেকিং বা কেকের জন্য:** ১/৪ কাপ অ্যাপেলসস বা পাকা কলা ম্যাশ।\n- **প্যানকেকের জন্য:** ১ চামচ তিসির গুঁড়ো + ৩ চামচ পানি।";
                            } else {
                                reply = "🔄 **শেফ টিপস:** আপনি রান্নায় কোন উপাদানটির বিকল্প খুঁজছেন আমাকে জানান, আমি সাহায্য করছি!";
                            }
                        } else if (userMsg.includes('ডিম') && userMsg.includes('আলু')) {
                            reply = "🍳 **ডিম ও আলু দিয়ে চমৎকার কিছু রেসিপি:**\n১. **ডিম আলুর ডালনা বা কোরমা:** সেদ্ধ ডিম ও আলু ভালো করে ভেজে দারুণ গ্রেভি তৈরি করুন।\n২. **আলু ডিম পরোটা:** সেদ্ধ আলু ও ডিম দিয়ে মসলা মিশিয়ে গরম গরম পরোটা বানান।";
                        } else if (userMsg.includes('হাই') || userMsg.includes('হ্যালো') || userMsg.includes('কেমন')) {
                            reply = "👋 **নমস্কার! আমি শেফবট (ChefBot), রেসিপিলির এআই কুকিং অ্যাসিস্ট্যান্ট।**\n\nআপনার কাছে কী কী উপাদান আছে বলুন, আমি দারুণ দারুণ রেসিপি বাতলে দেব। আজ কী রান্না করতে চান?";
                        } else {
                            reply = `🍳 **শেফবট রান্নার পরামর্শ:**\n**"${message}"** দিয়ে রান্না করতে চাইলে সঠিক মশলা ও পরিমিত আঁচে রান্না করুন।`;
                        }

                        if (matchedRecipes.length > 0) {
                            reply += `\n\n✨ **রেসিপিলির সম্পর্কিত রেসিপি:**\n` +
                                matchedRecipes.map(r => `• **[${r.recipeName}](/all-recipes/${r._id})** — *${r.category || 'Dish'} (${r.preparationTime || 'Quick'})*`).join('\n');
                        }
                    } else {
                        // --- ENGLISH RESPONSES ---
                        if (userMsg.includes('substitute') || userMsg.includes('alternative') || userMsg.includes('instead of')) {
                            if (userMsg.includes('buttermilk')) {
                                reply = "🥛 **Buttermilk Substitute:**\nMix **1 cup whole milk** with **1 tablespoon lemon juice or white vinegar**. Let it sit for 5 minutes until slightly curdled. It works just like fresh buttermilk!";
                            } else if (userMsg.includes('egg')) {
                                reply = "🥚 **Egg Substitutes for Baking & Cooking:**\n- **For moisture & binding:** 1/4 cup unsweetened applesauce per egg.\n- **For fluffiness (pancakes/cakes):** 1 tbsp ground flaxseed + 3 tbsp water.\n- **For savory dishes:** 1/4 cup silken tofu or mashed potato.";
                            } else {
                                reply = "🔄 **Chef Tip for Substitutions:**\nAlways balance moisture, fat, and flavor! What specific ingredient would you like to substitute today?";
                            }
                        } else if (userMsg.includes('quick') || userMsg.includes('fast') || userMsg.includes('15') || userMsg.includes('20 min')) {
                            reply = "⚡ **Quick 15-20 Minute Cooking Ideas:**\n1. **Egg Fried Rice:** Day-old rice stir-fried with eggs, soy sauce, garlic, and scallions.\n2. **Garlic Butter Pasta:** Boil noodles, toss with sizzled garlic, butter, chili flakes, and parmesan.\n3. **Quick Vegetable Stir-Fry:** Crisp veggies sautéed in sesame oil and oyster sauce.";
                        } else if (userMsg.includes('hello') || userMsg.includes('hi') || userMsg.includes('hey')) {
                            reply = "👋 **Hello! I'm ChefBot, your AI Cooking Assistant at Recipely.**\n\nI can help you with:\n- 🍳 Finding dishes based on ingredients in your fridge\n- 🔄 Ingredient substitutions\n- ⏱️ Quick meal ideas & cooking tips\n\nWhat are you in the mood to cook today?";
                        } else {
                            reply = `🍳 **ChefBot Cooking Recommendation:**\nFor **"${message}"**, try balancing spices, aromatics (garlic, onion, ginger), and fresh herbs to make the flavors pop!`;
                        }

                        if (matchedRecipes.length > 0) {
                            reply += `\n\n✨ **Matching Recipes on Recipely:**\n` +
                                matchedRecipes.map(r => `• **[${r.recipeName}](/all-recipes/${r._id})** — *${r.category || 'Dish'} (${r.preparationTime || 'Quick'})*`).join('\n');
                        }
                    }
                }

                res.send({
                    reply,
                    matchedRecipes: matchedRecipes.map(r => ({
                        id: r._id,
                        name: r.recipeName,
                        image: r.recipeImage,
                        category: r.category,
                        time: r.preparationTime
                    }))
                });
            } catch (error) {
                console.error("AI chat error:", error);
                res.status(500).send({ message: "ChefBot is resting. Please try again in a moment." });
            }
        });

        // get all transactions
        app.get('/api/transactions', verifyToken, verifyAdmin, async (req, res) => {
            const cursor = transactionsCollection.find().sort({ paidAt: -1 });
            const transactions = await cursor.toArray();
            res.send(transactions);
        });

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